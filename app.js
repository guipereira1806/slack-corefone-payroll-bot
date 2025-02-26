require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importa el fetch (solo si Node.js es < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Crea el servidor Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializa la app de Slack SIN Socket Mode
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Middleware para procesar JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Conecta el receptor de Slack Bolt con Express
app.use('/slack/events', slackApp.receiver.router);

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
    console.log('Datos leídos del CSV:', data);

    for (const row of data) {
      const slackUserId = row['Slack User']; // Columna con el ID del usuario en Slack
      const salary = row['Salary'];            // Columna con el salario
      const agentName = row['Name'];           // Columna con el nombre del agente
      const faltas = row['Faltas'] || 0;         // Columna con el número de faltas
      const feriadosTrabalhados = row['Feriados Trabalhados'] || 0; // Columna con feriados trabajados

      if (slackUserId && salary) {
        // Envía DM al agente
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId, // Usa el ID del usuario directamente
          text: message,
        });
        console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);

        // Almacena el ID del mensaje enviado para rastrear reacciones
        sentMessages[result.ts] = { user: slackUserId, name: agentName };
      }
    }

    // Responde en el canal privado con un check
    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: '¡Hoja de cálculo procesada! ✅',
    });

    // Elimina el archivo después del procesamiento
    fs.unlinkSync(filePath);
    res.status(200).send('¡Hoja de cálculo procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la hoja de cálculo:', error);
    res.status(500).send('Error al procesar la hoja de cálculo.');
  }
});

// Función para leer el archivo CSV
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

// Función para generar el mensaje personalizado en español latinoamericano
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
  const faltasText =
    faltas === 1
      ? `hubo *${faltas} falta*`
      : faltas > 1
      ? `hubo *${faltas} faltas*`
      : '*no hubo faltas*';
  const feriadosText =
    feriadosTrabalhados === 1
      ? `trabajó en *${feriadosTrabalhados} feriado*`
      : feriadosTrabalhados > 1
      ? `trabajó en *${feriadosTrabalhados} feriados*`
      : '*no trabajó en ningún feriado*';

  return `
:wave: *¡Hola, ${name}!*
Esperamos que estés bien. Te compartimos los detalles de tu salario de este mes.

*Valor del salario a pagar este mes:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Al emitir la factura, incluye el valor del tipo de cambio utilizado y el mes de referencia. Ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente + cambio utilizado (US$ 1 = ARS 918,50)
  \`\`\`

*Detalles adicionales:*
• Faltas: ${faltasText}.
• Feriados trabajados: ${feriadosText}.

*En caso de que no haya pendientes*, puedes emitir la factura con los valores anteriores hasta el último día hábil del mes.

Por favor, confirma que recibiste este mensaje y aceptas los valores reaccionando con un ✅ (*check*).

¡Agradecemos tu atención y te deseamos un excelente trabajo!
_Atentamente,_  
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
      text: `Agente ${name} (@${slackUserId}) confirmó la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

// Listener para mensajes en DM
slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;
  // Verifica si el mensaje fue enviado en un DM
  const conversationType = await slackApp.client.conversations.info({ channel });
  if (conversationType.channel.is_im) {
    console.log(`Mensaje recibido de ${user} en DM: ${text}`);
    await say(`¡Hola! Recibí tu mensaje: "${text}". Si necesitas algo, ¡estoy aquí!`);
  }
});

// Listener para uploads de archivos
slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;
    // Obtiene información sobre el archivo
    const fileInfo = await slackApp.client.files.info({ file: file_id });
    console.log('Archivo compartido:', fileInfo.file);
    // Verifica si el archivo es un CSV
    if (fileInfo.file.filetype === 'csv') {
      // Descarga el archivo CSV
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
      // Lee el contenido del archivo CSV
      const data = await readCsvFile(filePath);
      console.log('Datos leídos del CSV:', data);
      // Procesa los datos del CSV
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
          console.log(`Mensaje enviado para ${agentName} (ID: ${slackUserId}):`, message);
          sentMessages[result.ts] = { user: slackUserId, name: agentName };
        }
      }
      await slackApp.client.chat.postMessage({ channel: channel_id, text: '¡Hoja de cálculo procesada! ✅' });
      fs.unlinkSync(filePath);
    } else {
      console.log('El archivo compartido no es un CSV.');
    }
  } catch (error) {
    console.error('Error al procesar el archivo compartido:', error);
  }
});

// Ruta para responder a pings (UptimeRobot)
app.get('/', (req, res) => {
  res.status(200).send('¡El bot está en ejecución!');
});

// Ruta HEAD para evitar errores en peticiones no tratadas
app.head('/', (req, res) => {
  res.status(200).end();
});

// Inicia el servidor Express (Render asigna el puerto mediante process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 El servidor Express está en ejecución en el puerto ${PORT}!`);
});
