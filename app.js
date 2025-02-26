require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importa fetch (solo si Node.js es < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializa la app de Slack SIN Socket Mode
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Almacena los mensajes enviados para rastrear reacciones
const sentMessages = {};

// Ruta para recibir archivos mediante Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No se ha enviado ningún archivo.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Datos leídos del archivo CSV:', data);

    for (const row of data) {
      const slackUserId = row['Slack User'];
      const salary = row['Salary'];
      const agentName = row['Name'];
      const faltas = row['Faltas'] || 0;
      const feriadosTrabalhados = row['Feriados Trabalhados'] || 0;

      if (slackUserId && salary) {
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: message,
        });
        console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);
        sentMessages[result.ts] = { user: slackUserId, name: agentName };
      }
    }

    await slackApp.client.chat.postMessage({
      channel: req.body.channel_id,
      text: '✅ Archivo procesado correctamente.',
    });

    fs.unlinkSync(filePath);
    res.status(200).send('✅ Archivo procesado correctamente.');
  } catch (error) {
    console.error('❌ Error al procesar el archivo:', error);
    res.status(500).send('❌ Hubo un problema al procesar el archivo.');
  }
});

// Función para leer archivos CSV
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

// Genera un mensaje personalizado
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
  const faltasText = faltas === 1 
    ? `tuviste *${faltas} falta*` 
    : faltas > 1 
    ? `tuviste *${faltas} faltas*` 
    : '*no tuviste faltas*';
  const feriadosText = feriadosTrabalhados === 1 
    ? `trabajaste *${feriadosTrabalhados} día feriado*` 
    : feriadosTrabalhados > 1 
    ? `trabajaste *${feriadosTrabalhados} días feriados*` 
    : '*no trabajaste en días feriados*';

  return `
👋 *¡Hola ${name}!*
Esperamos que estés bien. Aquí están los detalles de tu pago de este mes:

💰 *Salario a pagar:* *USD ${salary}*

📌 *Instrucciones para facturación:*
• Debes emitir tu factura hasta el *último día hábil del mes*.
• Al emitirla, incluye el tipo de cambio utilizado y el mes de referencia. Ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento en servicio al cliente + tipo de cambio (USD 1 = ARS $950)
  \`\`\`

📊 *Detalles adicionales:*
• Faltas: ${faltasText}.
• Días feriados trabajados: ${feriadosText}.

Si no hay ajustes pendientes, puedes emitir tu factura con estos valores antes del cierre del mes.

✅ *Por favor, confirma que recibiste este mensaje y que estás de acuerdo con los valores reaccionando con un check (✅).*

Gracias por tu atención. ¡Te deseamos un excelente trabajo!
📩 _Atentamente,_  
*Supervisión Corefone AR/LATAM*
`;
}

// Monitorea reacciones a los mensajes
slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item } = event;

  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `📢 *${name} (@${slackUserId}) confirmó la recepción del pago y está de acuerdo con los valores.* ✅`,
    });
  }
});

// Listener para mensajes en DMs
slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;
  const conversationType = await slackApp.client.conversations.info({ channel });

  if (conversationType.channel.is_im) {
    console.log(`📩 Mensaje recibido de ${user} en DM: ${text}`);
    await say(`¡Hola! Recibí tu mensaje: "${text}". Si necesitas ayuda, aquí estoy. 😊`);
  }
});

// Listener para carga de archivos
slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;
    const fileInfo = await slackApp.client.files.info({ file: file_id });

    if (fileInfo.file.filetype === 'csv') {
      const fileUrl = fileInfo.file.url_private_download;
      const filePath = path.join(__dirname, 'uploads', fileInfo.file.name);
      const response = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

      const data = await readCsvFile(filePath);

      for (const row of data) {
        const slackUserId = row['Slack User'];
        const salary = row['Salary'];
        const agentName = row['Name'];
        const faltas = row['Faltas'] || 0;
        const feriadosTrabalhados = row['Feriados Trabalhados'] || 0;

        if (slackUserId && salary) {
          const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
          const result = await slackApp.client.chat.postMessage({
            channel: slackUserId,
            text: message,
          });
          sentMessages[result.ts] = { user: slackUserId, name: agentName };
        }
      }

      await slackApp.client.chat.postMessage({
        channel: channel_id,
        text: '✅ Archivo procesado correctamente.',
      });

      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('❌ Error al procesar el archivo compartido:', error);
  }
});

// Inicia el servidor correctamente con puerto automático
(async () => {
  await slackApp.start();
  console.log('⚡️ ¡La app de Slack Bolt está en ejecución!');

  const PORT = process.env.PORT || 0; // Asigna automáticamente un puerto disponible
  app.use(slackApp.receiver.app);

  const server = app.listen(PORT, () => {
    console.log(`🚀 ¡El servidor Express está en ejecución en el puerto ${server.address().port}!`);
  });
})();
