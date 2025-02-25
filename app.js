require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
app.use(express.json()); // Garante que o corpo da requisição seja tratado corretamente
const upload = multer({ dest: 'uploads/' });

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const sentMessages = {};

// ✅ Correção do erro de verificação do Slack
app.post('/slack/events', (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }
});

// Rota para receber arquivos via Slash Command
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

        sentMessages[result.ts] = {
          user: slackUserId,
          name: agentName,
        };
      }
    }

    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: '¡Planilla procesada! ✅',
    });

    fs.unlinkSync(filePath);
    res.status(200).send('¡Planilla procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la planilla:', error);
    res.status(500).send('Error al procesar la planilla.');
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
  const faltasText = faltas === 1 
    ? `tuvo *${faltas} falta*` 
    : faltas > 1 
    ? `tuvo *${faltas} faltas*` 
    : '*no tuvo faltas*';
  const feriadosText = feriadosTrabalhados === 1 
    ? `trabajó en *${feriadosTrabalhados} feriado*` 
    : feriadosTrabalhados > 1 
    ? `trabajó en *${feriadosTrabalhados} feriados*` 
    : '*no trabajó en ningún feriado*';

  return `
:wave: *¡Hola, ${name}!*
Esperamos que todo esté bien. Queremos compartir contigo los detalles de tu salario de este mes.

*Salario a recibir este mes:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse hasta el _penúltimo día hábil del mes_.
• Al emitir la factura, incluye la tasa de cambio utilizada y el mes de referencia. Aquí tienes un ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente + tipo de cambio utilizado (US$ 1 = BR$ 5,55)
  \`\`\`

*Detalles adicionales:*
• Faltas: ${faltasText}.
• Feriados trabajados: ${feriadosText}.

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores hasta el penúltimo día hábil del mes.

Por favor, confirma que has recibido este mensaje y estás de acuerdo con los valores reaccionando con un ✅ (*check*).

¡Gracias por tu atención y que tengas un excelente día!
_Atentamente,_  
*Supervisión Corefone AR/LATAM*
`;
}

// Monitora reações de confirmação ✅
slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item } = event;
  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `El agente ${name} (@${slackUserId}) confirmó la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

// Responde a mensagens diretas
slackApp.event('message', async ({ event, say }) => {
  const { text, user } = event;
  console.log(`Mensaje recibido de ${user} en DM: ${text}`);
  await say(`¡Hola! Recibí tu mensaje: "${text}". Si necesitas algo, ¡estoy aquí!`);
});

// Rota de teste para verificar se o bot está rodando
app.get('/', (req, res) => {
  res.status(200).send('¡El bot está en funcionamiento!');
});

app.head('/', (req, res) => {
  res.status(200).end();
});

// Inicia o bot e o servidor Express sem definir a porta
slackApp.start().then(() => {
  console.log(`⚡️ ¡La aplicación de Slack Bolt está funcionando!`);
});

app.listen(() => {
  console.log(`🚀 ¡El servidor Express está corriendo!`);
});
