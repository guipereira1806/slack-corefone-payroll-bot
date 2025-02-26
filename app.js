require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importa o fetch (apenas se o Node.js for < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Cria o servidor Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializa o app do Slack SEM Socket Mode
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Armazena as mensagens enviadas para rastrear reações
const sentMessages = {};

// Rota para receber arquivos via Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Verifica se o corpo da requisição contém o arquivo
    if (!req.file) {
      return res.status(400).send('Ningún archivo fue enviado.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Datos leídos del CSV:', data);

    for (const row of data) {
      const slackUserId = row['Slack User']; // Coluna com o ID do usuário no Slack
      const salary = row['Salary']; // Coluna com o salário
      const agentName = row['Name']; // Coluna com o nome do agente
      const faltas = row['Faltas'] || 0; // Coluna com o número de faltas
      const feriadosTrabalhados = row['Feriados Trabalhados'] || 0; // Coluna com feriados trabalhados

      if (slackUserId && salary) {
        // Envia DM para o agente
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId, // Usa o ID do usuário diretamente
          text: message,
        });
        console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);

        // Armazena o ID da mensagem enviada para rastrear reações
        sentMessages[result.ts] = {
          user: slackUserId,
          name: agentName,
        };
      }
    }

    // Responde ao canal privado com um check
    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: '¡Planilla procesada! ✅',
    });

    // Remove o arquivo após o processamento
    fs.unlinkSync(filePath);
    res.status(200).send('¡Planilla procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la planilla:', error);
    res.status(500).send('Error al procesar la planilla.');
  }
});

// Função para ler o arquivo CSV
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => data.push(row))
      .on('end', () => resolve(data))
      .on('error', (error) => reject(error));
  });
}

// Função para gerar a mensagem personalizada em espanhol
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
  const faltasText = faltas === 1 
    ? `hubo *${faltas} ausencia*` 
    : faltas > 1 
    ? `hubo *${faltas} ausencias*` 
    : '*no hubo ausencias*';
  const feriadosText = feriadosTrabalhados === 1 
    ? `trabajó en *${feriadosTrabalhados} día festivo*` 
    : feriadosTrabalhados > 1 
    ? `trabajó en *${feriadosTrabalhados} días festivos*` 
    : '*no trabajó en ningún día festivo*';

  return `
:wave: *¡Hola, ${name}!*
Esperamos que estés bien. Pasamos por aquí para compartir los detalles de tu salario correspondiente a este mes.

*Valor del salario a pagar este mes:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Al emitir la factura, incluye el valor del tipo de cambio utilizado y el mes de referencia. Aquí tienes un ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente + cambio utilizado (US$ 1 = ARS $950,55)
  \`\`\`

*Detalles adicionales:*
• Ausencias: ${faltasText}.
• Días festivos trabajados: ${feriadosText}.

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores hasta el último día hábil del mes.

Por favor, confirma que has recibido este mensaje y estás de acuerdo con los valores anteriores reaccionando con un ✅ (*check*).

¡Agradecemos tu atención y te deseamos un excelente trabajo!
_Atentamente,_  
*Supervisión Corefone AR/LATAM*
`;
}

// Monitora reações às mensagens
slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item, user } = event;

  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `El agente ${name} (@${slackUserId}) ha confirmado la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

// Listener para mensagens em DMs
slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;

  // Verifica se a mensagem foi enviada em uma DM
  const conversationType = await slackApp.client.conversations.info({ channel });
  if (conversationType.channel.is_im) {
    console.log(`Mensaje recibido de ${user} en DM: ${text}`);
    await say(`¡Hola! Recibí tu mensaje: "${text}". Si necesitas algo, ¡estoy aquí!`);
  }
});

// Listener para uploads de arquivos
slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;

    // Obtém informações sobre o arquivo
    const fileInfo = await slackApp.client.files.info({
      file: file_id,
    });
    console.log('Archivo compartido:', fileInfo.file);

    // Verifica se o arquivo é um CSV
    if (fileInfo.file.filetype === 'csv') {
      // Baixa o arquivo CSV
      const fileUrl = fileInfo.file.url_private_download;
      const filePath = path.join(__dirname, 'uploads', fileInfo.file.name);
      const response = await fetch(fileUrl, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        },
      });
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
      console.log(`Archivo descargado: ${filePath}`);

      // Lê o conteúdo do arquivo CSV
      const data = await readCsvFile(filePath);
      console.log('Datos leídos del CSV:', data);

      // Processa os dados do CSV
      for (const row of data) {
        const slackUserId = row['Slack User']; // Coluna com o ID do usuário no Slack
        const salary = row['Salary']; // Coluna com o salário
        const agentName = row['Name']; // Coluna com o nome do agente
        const faltas = row['Faltas'] || 0; // Coluna com o número de faltas
        const feriadosTrabalhados = row['Feriados Trabalhados'] || 0; // Coluna com feriados trabalhados

        if (slackUserId && salary) {
          // Envia DM para o agente
          const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
          const result = await slackApp.client.chat.postMessage({
            channel: slackUserId, // Usa o ID do usuário diretamente
            text: message,
          });
          console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);

          // Armazena o ID da mensagem enviada para rastrear reações
          sentMessages[result.ts] = {
            user: slackUserId,
            name: agentName,
          };
        }
      }

      // Responde ao canal privado com um check
      await slackApp.client.chat.postMessage({
        channel: channel_id,
        text: '¡Planilla procesada! ✅',
      });

      // Remove o arquivo após o processamento
      fs.unlinkSync(filePath);
    } else {
      console.log('El archivo compartido no es un CSV.');
    }
  } catch (error) {
    console.error('Error al procesar el archivo compartido:', error);
  }
});

// Rota para responder aos pings do UptimeRobot
app.get('/', (req, res) => {
  res.status(200).send('¡El bot está funcionando!');
});

// Rota HEAD para evitar erros de requisições não tratadas
app.head('/', (req, res) => {
  res.status(200).end();
});

// Conecta o Bolt ao servidor Express
slackApp.start(process.env.PORT || 3000).then(() => {
  console.log(`⚡️ La aplicación Slack Bolt está funcionando en el puerto ${process.env.PORT || 3000}!`);
});

// Inicia o servidor Express
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 El servidor Express está funcionando en el puerto ${process.env.PORT || 3000}!`);
});
