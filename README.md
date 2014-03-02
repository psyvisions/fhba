File Hosting Bitcoin Agent
====

##WARNING
This project is in early development. It may swallow bitcoins that are thrown its way. Use with caution.


##Usage
There are 2 ways to use this program:
 - upload a file and pay / MB / minute. Each download costs 10 minutes and files are deleted when the timer expires.
 - upload a file with a fee and a referral address. Each download costs that fee (which goes to the uploader) and an extra percentage to keep the file online for longer. This allows artists to upload files and distribute them on a pay / view model.

###API

Upload a file and pay per minute / MB. Anyone with the link can download the file. This is good for short term file hosting / sharing.
```
/upload
params: 
 upload, type: file
 title, type: text, optional
```

Upload a file for pay / view. Each time someone wants to download it they have to pay you a referral fee.
```
Path: /upload
Params: [{name: upload, type: file}, {name: title, type: text, optional: true}, {name: referralBTCAddress, type: text}, {name: referralBTCPrice, type: text}]
```


##Dependancies:

###bitcoind
sudo apt-get install python-software-properties

sudo add-apt-repository ppa:bitcoin/bitcoin

sudo apt-get update

sudo apt-get install bitcoind

mkdir ~/.bitcoin/

###mongodb
sudo apt-get install mongodb

###nodejs
sudo apt-get update

sudo apt-get install -y python-software-properties python g++ make

sudo add-apt-repository ppa:chris-lea/node.js

sudo apt-get update

sudo apt-get install nodejs

##To run
node server.js
