var formidable = require('formidable'),
    http = require('http'),
    fs = require('fs'),
    url = require("url"),
    util = require('util'),
    request = require('request'),
    btcAddr = require('bitcoin-address'),
    path = require('path'),
    mime = require('mime'),
    MongoClient = require('mongodb').MongoClient,
    format = require('util').format,
    cronJob = require('cron').CronJob,
    mongo = require('mongodb'),
    BSON = mongo.BSONPure,
    bitcoin = require('bitcoin'),
    logly = require( 'logly' ),
    config = require('./config');



var minutesPerBTCPerMB = 1051200, //2 years in minutes
    minutesBurnedPerDownload = 10, //1 download = 10 minutes of storage. Size is accounted for already.
    margin = 1.5, //margin charged
    collection = null;

//connect to bitcoin daemon
var client = new bitcoin.Client({
  host: 'localhost',
  port: 19011,
  user: 'admin1',
  pass: '123'
}); 

logly.name( 'bitcoin agent' );
logly.mode( 'debug' );


logly.log('Connecting to mongo');
MongoClient.connect('mongodb://127.0.0.1:27017/test', function(err, db) { 


  if(err) throw err; 
  collection = db.collection('uploadedFiles4');

  logly.log('Connection to mongo complete');

  //collection.ensureIndex({expiryTime: 1});

  //every minute delete files that have expired.
  new cronJob('* * * * *', function(){

    collection.find({expiryTime: {$lt: new Date().getTime()}}).toArray(function(err, items) {
      collection.remove({expiryTime: {$lt: new Date().getTime()}}, function(err) {
        console.log(items.length + ' expired files deleted.');
      });

      //remove the actual files from disk
      for (var i=0; i<items.length; i++){
        fs.unlink(items[i].upload.path, function (err) {
          if (err) throw err;
          console.log('successfully deleted file.');
        });
      }

    });
  }, null, true);    

  //every 10 seconds check if payment is received
  var paymentCron = new cronJob('*/10 * * * * *', function(){

    collection.find().toArray(function(err, items) {
      if (err) return logly.error(err);
      
      for (var i=0; i<items.length; i++){

        var thisID = items[i]._id.toString();
        var oldBalance = parseFloat(items[i].btcBalance);
        var filesize = items[i].upload.size/1000000; //size in MB
        var thisbitcoinAddress = items[i].bitcoinAddress;

        //if bitcoin payment is received then extend expiry time by 1 minute / satoshi     
        //client.getBalance(items[i].bitcoinAddress, 0, function(err, balance) {
        request('https://blockchain.info/address/'+thisbitcoinAddress+'?format=json', function (error, response, body) {
          if (!error && response.statusCode == 200) {

            var json = JSON.parse(body);
            var balance = json.total_received / 100000000;

            logly.debug('Balance for ' + thisbitcoinAddress + ' = ' + balance);


            if (oldBalance != balance){

              //update balance in DB
              collection.update({ '_id': new BSON.ObjectID(thisID) },{ $set: { btcBalance: (balance) } }, function(err, doc){
                if (err) return logly.error(err);
                logly.log('BTC balance updated for wallet ID ' + thisbitcoinAddress + ' - new balance: ' + balance)
              });

              //extend expiry time by correct amount.
              var btcDiff = balance - oldBalance;
              var minutesToExtend = btcDiff*minutesPerBTCPerMB/filesize;
              collection.update({ '_id': new BSON.ObjectID(thisID) },{ $inc: { expiryTime: (minutesToExtend*60*1000) } }, function(err, doc){
                if (err) return logly.error(err);
                logly.log('Extended expiry time by ' + minutesToExtend);
              });

            }
          }else{
            logly.error('Cannot connect to blockexplorer.com');
          }

        }); 
      }
    });
  }, null, true);





  //create http server
  http.createServer(function(req, res) {

    if (req.url == '/upload' && req.method.toLowerCase() == 'post') {
      // parse a file upload
      var form = new formidable.IncomingForm();
      form.keepExtensions = true;


      form.parse(req, function(err, fields, file) {
        
        var id = null;

        //store name of file and details in mongodb
        file.title = fields.title;
        file.referralBTCAddress = fields.referralBTCAddress;
        file.referralBTCPrice = fields.referralBTCPrice;
	
      	//store uploaded time
      	file.uploadedDate = new Date().getTime();
              
      	//store expiry time 30 minutes in the future
        file.expiryTime = new Date().getTime() + (30*60*1000);

        //generate new bitcoin address for payments
        client.cmd('getnewaddress',function(err,address){
          if (err) return logly.log(err);

          file.bitcoinAddress = address;
          file.btcBalance = 0.00000000;

          file.btcDownloadCost = Math.max(file.referralBTCPrice * margin, (file.upload.size / 1000000 / minutesPerBTCPerMB * minutesBurnedPerDownload * margin) + parseFloat(file.referralBTCPrice));//max of referral * margin or (our base costs + referral price) * margin - accounts for very low referral cost uploads.

          collection.insert(file, function(err, docs) {

            id = docs[0]._id;

            collection.count(function(err, count) {
              console.log(format("Uploaded file count since last reset = %s", count));
            });

            //return only public items
            var thisItem = {};
            thisItem.size = file.upload.size;
            thisItem.name = file.upload.name;
            thisItem.type = file.upload.type;
            thisItem.title = file.title;
            thisItem.uploadedDate = file.uploadedDate;
            thisItem.expiryTime = file.expiryTime;
            thisItem.bitcoinAddress = file.bitcoinAddress;
            thisItem.btcBalance = file.btcBalance;
            thisItem.serverTime = new Date().getTime();
            thisItem.downloadURL = '/download/' + id;
            thisItem.statusURL = '/status/' + id;

            //send response to user
            res.writeHead(200, {'content-type': 'application/json'});
            res.write(JSON.stringify(thisItem));
            return res.end();
            
          });
        });
      });

      return;
    }


    var downloadURL = '/download/';
    if (strStartsWith(req.url,downloadURL)){

      var fileID = req.url.substring(downloadURL.length);
      
      //if requesting supossedly paid download
      if (fileID.indexOf('/?payment=') != -1){

        fileID = fileID.substring(0, req.url.indexOf('/?payment=') - 10);

        var addressacc = req.url.substring(req.url.indexOf('/?payment=') + 10);
        var address = addressacc.substring(0, addressacc.indexOf('&account='));
        var bitcoindAccount = addressacc.substring(addressacc.indexOf('&account=') + 9);

        //check payment is received
        //client.cmd('getbalance', address, 0, function(err, balance){ //this doesn't work as it's based on account not addresses
        request('https://blockchain.info/address/'+address+'?format=json', function (error, response, body) {
          if (!error && response.statusCode == 200) {
            var json = JSON.parse(body);
            var balance = json.total_received / 100000000;

            collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {
              if (item != null){
                if (balance >= item.btcDownloadCost){

                  if (addressInItemDownloadAddresses(address,item)){ //address could be any address - check it's in the array

                    //allow download (once) 
                    console.log('Downloading paid file : ' + item.upload.path);

                    var file = item.upload.path;
                    var filename = path.basename(file);
                    var mimetype = mime.lookup(file);

                    res.setHeader('Content-disposition', 'attachment; filename=' + filename);
                    res.setHeader('Content-type', mimetype);

                    var filestream = fs.createReadStream(file);
                    filestream.pipe(res);

                    //delete download url
                    collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: false, account: bitcoindAccount} } }, function(err, doc){
                      if (err) return logly.error(err);
                      if(doc != 1) return console.log('Error - ' + doc);

                      console.log('Deleted download address after single paid download.');
                    });

                    //make bitcoin payments: referralBTCPrice to the referralBTCAddress, 50% of what is left to the downloaded file's fee address, and the rest to the owner.
                    //to deal with transaction fees this will have to pay out only once there is a high enough balance.
                    //payments can be queued and batched once a certain threshold is reached.
                    //TODO

                  }else{
                    res.writeHead(200, {'content-type': 'text/plain'});
                    res.write('Address not linked to file.');
                    return res.end();
                  }

                }else{
                  res.writeHead(200, {'content-type': 'text/plain'});
                  res.write('No payment received.');
                  return res.end();
                }
              }else{
                res.writeHead(200, {'content-type': 'text/plain'});
                res.write('Error. Item has expired.');
                return res.end();
              }
            });
          }else{
            logly.error(error);
            res.writeHead(200, {'content-type': 'text/plain'});
            res.write('Error. Cannot connect to blockexplorer.com');
            return res.end();
          }
        });

        return;
      }

      //get path from mongo (if file exists)
      if (fileID.length == 24){
        collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {

            if (item != null){


              //two file types: 1 - prepaid by uploader, anyone who downloads pays and proceeds are split between admin, program (expiry extension), and uploader
              if (btcAddr.validate(item.referralBTCAddress)){ //if referral address exists.

                //Create new btcaddress for downloader with 15 minutes to pay
                //After payment the user can download using currentURL?payment=NewBitcoinAddress
                //attach address to account:
                var bitcoindAccount = fileID+(new Date().getTime());
                client.cmd('getnewaddress', bitcoindAccount, function(err,address){
                  if (err) return console.log(err);

                  collection.update({ '_id': new BSON.ObjectID(fileID) },{ $push: { downloadAddress: {address: address, paid: false, account: bitcoindAccount} } }, function(err, doc){
                    if (err) return console.log(err);

                    if(doc != 1){
                      console.log('Error - ' + doc);
                      return;
                    }

                    console.log("Added address " + address + "to file.");

                    var responseItem = {
                      amountToPay: item.btcDownloadCost,
                      timeToPay: '15 minutes',
                      paymentAddress: address,
                      downloadLink: '/download/' + fileID + '/?payment=' + address + '&account=' + bitcoindAccount
                    };

                    //delete download address after 15 minutes if btc payment is not complete.
                    var myTimeout = setTimeout(function() {
                      collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: false, account: bitcoindAccount} } }, function(err, doc){
                        if (err) return console.log(err);
                        if(doc != 1) return console.log('Error - ' + doc);
                        console.log('Added new address for download payment');
                      });
                    }, 15 * 60 * 1000); //15 minutes

                    var x=0;
                    var myInterval = setInterval(function() {

                      //if payment not made delete the download address
                      request('https://blockchain.info/address/'+address+'?format=json', function (error, response, body) {
                        if (!error && response.statusCode == 200) {

                          var json = JSON.parse(body);
                          var balance = json.total_received / 100000000;

                          if (balance < item.btcDownloadCost){  //not paid
                            //if 15 minutes past then address will be deleted by timeout above.
                            
                            //if 15 minutes past then stop this interval
                            if(x >= 90){
                              clearInterval(myInterval); //stop this interval being called again.
                            }
                            
                            x++;

                          }
                        }else{
                          res.writeHead(200, {'content-type': 'text/plain'});
                          res.write('Error. Cannot connect to blockexplorer.com');
                          return res.end();
                        }
                      });

                    }, 10 * 1000); //10 seconds

                    res.writeHead(200, {'content-type': 'application/json'});
                    res.write(JSON.stringify(responseItem));
                    return res.end();

                  });
                });


              }else{ //two file types: 2 - prepaid by uploader, and expiry time decreases as time goes on.


                //Don't let file be downloaded if nothing has been paid.
                var blockchainurl = 'https://blockchain.info/address/'+item.bitcoinAddress+'?format=json';

                request(blockchainurl, function (error, response, body) {
                  if (!error && response.statusCode == 200) {

                    var json = JSON.parse(body);
                    var balance = json.total_received / 100000000;

                    if (balance == 0){
                      res.writeHead(200, {'content-type': 'text/plain'});
                      res.write('Please make payment first.');
                      return res.end();
                    }

                    //Reduce expiry time by bandwidth charge/cost
                    minutesBurned = -1 * minutesBurnedPerDownload * 60 * 1000; //minutes to milliseconds
                    collection.update({ '_id': new BSON.ObjectID(fileID) },{ $inc: { expiryTime: (minutesBurned) } }, function(err, doc){
                      if (err) return console.log(err);

                      if(doc != 1){
                        console.log('Error - ' + doc);
                        return;
                      }   

                      //download file
                      console.log('Downloading : ' + item.upload.path);

                      var file = item.upload.path;
                      var filename = path.basename(file);
                      var mimetype = mime.lookup(file);

                      res.setHeader('Content-disposition', 'attachment; filename=' + filename);
                      res.setHeader('Content-type', mimetype);

                      var filestream = fs.createReadStream(file);
                      filestream.pipe(res);

                    }); 
                  }else{
                    res.writeHead(200, {'content-type': 'text/plain'});
                    res.write('Error. Cannot connect to blockexplorer.com');
                    return res.end();
                  }
                });
              }

            }else{
              res.writeHead(200, {'content-type': 'text/plain'});
              res.write('File not found.');
              return res.end();
            }

        });
      }else{
          res.writeHead(200, {'content-type': 'text/plain'});
          res.write('File not found.');
          return res.end();
      }
      return;
    }

    var statusURL = '/status/';
    if (strStartsWith(req.url,statusURL)){

      //get path from mongo (if file exists)
      var fileID = req.url.substring(statusURL.length);
      if (fileID.length == 24){
        collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {

            if (item != null){

              //return only public items
              var thisItem = {};
              thisItem.size = item.upload.size;
              thisItem.name = item.upload.name;
              thisItem.type = item.upload.type;
              thisItem.title = item.title;
              thisItem.uploadedDate = item.uploadedDate;
              thisItem.expiryTime = item.expiryTime;
              thisItem.bitcoinAddress = item.bitcoinAddress;
              thisItem.btcBalance = item.btcBalance;
              thisItem.serverTime = new Date().getTime();
              thisItem.downloadURL = '/download/' + item._id;
              thisItem.statusURL = '/status/' + item._id;

              //send response
              res.writeHead(200, {'content-type': 'application/json'});
              res.write(JSON.stringify(thisItem));
              return res.end();

            }else{
              res.writeHead(200, {'content-type': 'text/plain'});
              res.write('File not found.');
              return res.end();
            }

        });
      }else{
          res.writeHead(200, {'content-type': 'text/plain'});
          res.write('File not found.');
          res.end();
      }
      return;
    }

    // show a file upload form
    res.writeHead(200, {'content-type': 'text/html'});
    res.end(
      '<form action="/upload" enctype="multipart/form-data" method="post">'+
      '<p>This project is in alpha testing. Do not assume anything will work, it might swallow your money.</p>'+
      '<p>There are 2 ways of using this system:'+
      '<br/>1 : Upload a file, and pay for it to remain online. Every paid satoshi the file stays online for more time, every download the timer is cut short a bit.'+
      '<br/>2 : Upload a file with a refferal bitcoin address and a price. Every time someone downloads it they will pay that price + 50%. The price you set is paid to the referral btc address each time someone pays to download, and the 50% goes towards hosting that file for longer.</p>'+
      '<input type="text" name="title">Enter a title (optional)<br>'+
      '<input type="text" name="referralBTCAddress">Enter a refferal address (optional)<br>'+
      '<input type="text" name="referralBTCPrice">Enter a refferal price (optional)<br>'+
      '<input type="file" name="upload"><br>'+
      '<input type="submit" value="Upload">'+
      '</form>'
    );
  }).listen(8080);
})


//return true if str starts with prefix
function strStartsWith(str, prefix) {
    return str.indexOf(prefix) === 0;
}


//if address is in download addresses of item return true
function addressInItemDownloadAddresses(address, item){

  if (item.downloadAddress == null ){
    return false;
  }

  var downloadAddressArr = item.downloadAddress;
  for (var i = 0; i < downloadAddressArr.length; i++){
    if (downloadAddressArr[i].address == address){
      return true;
    }
  }

  return false;
}






