require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const upload = multer({ dest: 'uploads/' });

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const sentMessages = {};

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No se ha enviado ningún archivo.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Datos leídos del CSV:', data);

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

    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: '¡Hoja de cálculo procesada! ✅',
    });

    fs.unlinkSync(filePath);
    res.status(200).send('¡Hoja de cálculo procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la hoja de cálculo:', error);
    res.status(500).send('Error al procesar la hoja de cálculo.');
  }
});

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

function generateMessage(name, salary, faltas, feriadosTrabalhados) {
  return `:wave: ¡Hola ${name}!
Esperamos que todo esté bien. Aquí están los detalles de tu salario correspondiente a este mes.

*Valor del salario a pagar este mes:* US$${salary}

*Instrucciones para emisión de la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Al emitirla, incluye el tipo de cambio utilizado y el mes de referencia. Ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente + tipo de cambio utilizado (US$ 1 = ARS $950)
  \`\`\`

*Detalles adicionales:*
• Faltas: ${faltas ? `hubo *${faltas} faltas*` : '*no hubo faltas*'}.
• Feriados trabajados: ${feriadosTrabalhados ? `trabajó en *${feriadosTrabalhados} feriados*` : '*no trabajó en ningún feriado*'}.

Por favor, confirma que has recibido este mensaje y aceptas los valores reaccionando con ✅ (*check*).

_Atentamente,_  
*Supervisión Corefone AR/LATAM*`;
}

slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item } = event;
  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `Agente ${name} (@${slackUserId}) ha confirmado la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

app.use('/slack/events', slackApp.receiver.router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ¡El servidor Express está ejecutándose en el puerto ${PORT}!`);
});
