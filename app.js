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

// Middleware para analizar JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Conecta Express con Slack Bolt
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

    fs.unlinkSync(filePath);
    res.status(200).send('¡Hoja de cálculo procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la hoja de cálculo:', error);
    res.status(500).send('Error al procesar la hoja de cálculo.');
  }
});

// Función para leer archivo CSV
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
  const faltasText = faltas > 0 ? `tuvo *${faltas} faltas*` : '*no tuvo faltas*';
  const feriadosText = feriadosTrabalhados > 0 ? `trabajó en *${feriadosTrabalhados} feriados*` : '*no trabajó en ningún feriado*';
  
  return `
:wave: *¡Hola ${name}!*
Esperamos que estés bien. Aquí están los detalles de tu salario de este mes.

*Valor del salario a pagar:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Debe incluir el tipo de cambio utilizado y el mes de referencia. Ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente + tipo de cambio utilizado (US$ 1 = ARS $950,18)
  \`\`\`

*Detalles adicionales:*
• Faltas: ${faltasText}.
• Feriados trabajados: ${feriadosText}.

Si no hay pendientes, puedes emitir la factura con estos valores hasta el último día hábil del mes.
Por favor, confirma que recibiste este mensaje y aceptas los valores reaccionando con ✅ (*check*).

¡Gracias por tu atención y excelente trabajo!
_Atentamente,_  
*Supervisión Corefone LATAM*
  `;
}

// Escucha eventos de reacciones
slackApp.event('reaction_added', async ({ event }) => {
  if (event.reaction === 'white_check_mark' && sentMessages[event.item.ts]) {
    const { user: slackUserId, name } = sentMessages[event.item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `El agente ${name} (@${slackUserId}) confirmó la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

// Ruta para verificar el estado del bot
app.get('/', (req, res) => {
  res.status(200).send('¡El bot está en ejecución!');
});

// Inicia el servidor Express en el puerto asignado (Render asigna automáticamente el puerto a través de process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ¡Servidor Express ejecutándose en el puerto ${PORT}!`);
});
