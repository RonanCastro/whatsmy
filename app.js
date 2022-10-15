const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const axios = require('axios');
const port = process.env.PORT || 3000;
const urlServer = 'https://whatsmy.meux.com.br'
const cors = require('cors')

const app = express();

var corsOptions = {
  origin: urlServer,
  optionsSuccessStatus: 200
}

const server = http.createServer(app);
const io = socketIO(server);

app.use(cors(corsOptions))
app.use(express.json({limit: "10mb", extended: true}));
app.use(express.urlencoded({
  extended: true
}));

app.get('/', (req, res) => {
  return res.status(200).json({
    status: true,
    message: 'Servidor Online'
  });
})
const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function(sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = async function(id, description) {
  console.log('### CRIAR SESSAO ' + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  client.on('qr', async (qr) => {
      //let status = 1
      console.info('### QRCode Lido '+qr)
      console.info('### QRCode Servidor '+id)
     /* await axios.post(urlServer+'/apis/atualiza-servidor',{id,qr,status})
                    .then(resp => console.log(resp.data))
                    .catch( error => console.log(error.message)) */
      const savedSessions = getSessionsFile();
      const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
      savedSessions[sessionIndex].qrcode = qr;
      setSessionsFile(savedSessions);
  });

  client.on('ready', async () => {

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);

    let status = 2

   const users = await client.getChats()
   let telefones=''

   let telefoneservidor = client.info.wid._serialized.replace(/\D/g,'');
   
   for(const user of users){
      if(user.id.server.includes(`c.us`)){
        const userContact = user.id._serialized.replace(/\D/g,'')
        const userName = user.name
        console.log(userContact)
        telefones+=','+userContact+'|'+userName;
      }
    }

    await axios.post(urlServer+'/apis/atualiza-servidor',{id,status,telefones,telefoneservidor})
          .then( response => console.log(response.data))
          .catch( error => console.log(error.message))

    console.info('#Whatsapp  server '+id+' is ready!');
    console.info('#Enviando Mensagem');
    
    (function loop() {
          var rand = Math.round(Math.random() * (15000 - 7000)) + 7000;
          console.log('Executando em: '+rand/1000+' segundos')
          setTimeout(function() {
                  enviarMensagem(id)
                  loop();  
          }, rand);
      }());

  });

  client.on('authenticated', () => {
    let status = 2
    axios.post(urlServer+'/apis/atualiza-servidor',{id,status})
              .then( resp => console.log(resp.data))
              .catch( error => console.log(error.message))
  });

  client.on('auth_failure', function() {
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
  });
  
  client.on('disconnected', (reason) => {
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
    client.destroy();
    client.initialize();
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);
    io.emit('remove-session', id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    description: description,
    client: client
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }

  const enviarMensagem = function (sender){
    console.info('Solicitando mensagem do servidor: ', sender)
    axios.post(urlServer+'/apis/mensagem',{id:sender})
    .then(response => {

        if(response.data.erro==undefined){
          console.info('### Enviando mensagem para : '+response.data.number)
          const sender = response.data.sender;
          const number = phoneNumberFormatter(response.data.number);
          const message = response.data.message;
          const imagem = response.data.image ?? false;
          const client = sessions.find(sess => sess.id == sender)?.client;
              
          if (!client) {
            return res.status(422).json({
              status: false,
              message: `The sender: ${sender} is not found!`
            })
          }

          if(imagem){
              var media = new MessageMedia('image/jpg', imagem);
              client.sendMessage(number,media,{caption: message})
                    .then(response => {console.log('mensagem enviada para '+number)})
                    .catch(err => {console.log(err.message)}); 
          }else{
              client.sendMessage(number,message)
                    .then(response => {console.log('mensagem enviada')})
                    .catch(err => {console.log(err.message)}); 
          } 
        }          
    })
    .catch( error => console.log(error.message))
  }


  app.post('/remover-sessao', async (req, res) => {
    console.log('Remover Sessao '+req.body.id)
    try{
    
      let id = req.body.id
      const client = sessions.find(sess => sess.id == id)?.client;

        // Make sure the sender is exists & ready
        if (!client) {
          return res.status(422).json({
            status: false,
            message: ` ${id} is not found!`
          })
        }
    
        client.destroy();
        client.initialize();

      const savedSessions = getSessionsFile();
      const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
      savedSessions.splice(sessionIndex, 1);
      setSessionsFile(savedSessions);
   
       return res.status(200).json({
        status: true,
        message: `Sessão apagada`
      })
  
  
    } catch (error) {
        console.log(error);
        res.sendStatus(500);
    }
  
  })



}

const init = function(socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function(socket) {
  init(socket);
});

    



app.post('/status-sessao', async (req, res) => {
  console.info('### STATUS SESSAO',req.body)
  const sender = req.body.id
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == sender);
  const sessao = savedSessions[sessionIndex]
  if (!sessao) {
    return res.status(422).json({
      status: false,
      message: `The sender: is not found!`
    })
  }else{
    return res.status(200).json({
      status: sessao,
      message: `Sessao encontrada`
    })
  }

})


app.post('/nova-sessao', async (req, res) => {
  
  console.info('### NOVA SESSAO '+req.body)
  await createSession(req.body.id, req.body.description);
  console.log('Sessao criada, gerando QRCode... ') 
})



// Send message
app.post('/send-message', async (req, res) => {
  
  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;
  const imagem = req.body.image ?? false;
  const client = sessions.find(sess => sess.id == sender)?.client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  /**
   * Check if the number is already registered
   * Copied from app.js
   * 
   * Please check app.js for more validations example
   * You can add the same here!
   */
  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  if(!imagem){
        client.sendMessage(number, message).then(response => {
          res.status(200).json({
            status: true,
            response: response
          });
        }).catch(err => {
          res.status(500).json({
            status: false,
            response: err
          });
        });
  }else{
 
    var media = new MessageMedia('image/png', imagem);

    client.sendMessage(number, 
                      media,
                      {caption: message}).then(response => {
      res.status(200).json({
        status: true,
        response: response
      });
    }).catch(err => {
      res.status(500).json({
        status: false,
        response: err
      });
    });


  }
});

server.listen(port, function() {
  console.log('App running on *: ' + port);
});
