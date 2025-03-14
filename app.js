require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios'); // Substituindo node-fetch por axios

// Create upload directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Create the ExpressReceiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// Access the Express app
const app = receiver.app;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Slack app with the ExpressReceiver
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

// Store sent messages for tracking reactions
const sentMessages = new Map();
const processedFiles = new Set(); // Armazena os file_id já processados

// Utility functions
const logger = {
  info: (message, data = {}) => {
    console.log(`[INFO] ${message}`, data);
  },
  error: (message, error) => {
    console.error(`[ERROR] ${message}`, error);
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.debug(`[DEBUG] ${message}`, data);
    }
  }
};

/**
 * Read CSV file and parse its contents
 * @param {string} filePath - Path to the CSV file
 * @returns {Promise<Array>} - Parsed CSV data
 */
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => data.push(row))
      .on('end', () => {
        logger.info(`CSV file successfully processed: ${filePath}`, { rowCount: data.length });
        resolve(data);
      })
      .on('error', (error) => {
        logger.error(`Error reading CSV file: ${filePath}`, error);
        reject(error);
      });
  });
}

/**
 * Generate personalized message for a user in Spanish
 * @param {string} name - User's name
 * @param {number} salary - User's salary
 * @param {number} faltas - Number of absences
 * @param {number} feriadosTrabalhados - Number of holidays worked
 * @returns {string} - Formatted message in Spanish
 */
function generateMessage(name, salary, faltas = 0, feriadosTrabalhados = 0) {
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

  return `:wave: *¡Hola, ${name}!*
Esperamos que estés bien. Pasamos por aquí para compartir los detalles de tu salario correspondiente a este mes.

*Valor del salario a pagar este mes:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Al emitir la factura, incluye el mes de referencia. Sigue un ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente 
  \`\`\`

*Detalles adicionales:*
• Ausencias: ${faltasText}.
• Días festivos trabajados: ${feriadosText}.

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores hasta el último día hábil del mes. Por favor, envíe la factura a *corefone@domus.global*, con copia a *administracion@corefone.us*, *gilda.romero@corefone.us* y a los supervisores *maximiliano.varin@corefone.us*, *guilherme.santos@corefone.us* y *agustin.gonzalez@corefone.us*.

Por favor, confirma que has recibido este mensaje y estás de acuerdo con los valores anteriores reaccionando con un ✅ (*check*).

¡Agradecemos tu atención y te deseamos un excelente trabajo!
_Atentamente,_  
*Supervisión Corefone AR/LATAM*
`;
}

/**
 * Process CSV data and send notifications to users
 * @param {Array} data - Parsed CSV data
 * @param {string} channelId - Channel ID for confirmation messages
 * @returns {Promise<number>} - Number of messages sent
 */
async function processCSVData(data, channelId) {
  let messagesSent = 0;
  let reportMessages = '';  // Armazena a lista de mensagens a serem enviadas ao canal

  try {
    for (const row of data) {
      const slackUserId = row['Slack User']; 
      const salary = row['Salary']; 
      const agentName = row['Name'];
      const faltas = parseInt(row['Faltas'] || 0);
      const feriadosTrabalhados = parseInt(row['Feriados Trabalhados'] || 0);

      if (!slackUserId || !salary) {
        logger.info('Skipping row with missing Slack User ID or salary', { row });
        continue;
      }

      try {
        // Envia mensagem para o agente
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: message,
        });
        
        logger.info(`Message sent to ${agentName}`, { userId: slackUserId });
        messagesSent++;

        // Adiciona o relatório com os valores enviados para o canal
        reportMessages += `\n*${agentName}:* Salario: US$${salary}, Ausencias: ${faltas}, Días Festivos Trabajados: ${feriadosTrabalhados}`;
        
        // Armazena as informações da mensagem para rastrear reações
        sentMessages.set(result.ts, {
          user: slackUserId,
          name: agentName,
        });
      } catch (error) {
        logger.error(`Failed to send message to ${agentName} (${slackUserId})`, error);
      }
    }

    // Envia a confirmação ao canal, incluindo o relatório (em espanhol)
    if (channelId) {
      await slackApp.client.chat.postMessage({
        channel: channelId,
        text: `¡Archivo procesado! ✅ Mensajes enviados: ${messagesSent}/${data.length}.\n\n*Detalles enviados:*${reportMessages}`,
      });
    }
    
    return messagesSent;
  } catch (error) {
    logger.error('Error processing CSV data', error);
    throw error;
  }
}

// Route for slash command to upload CSV file
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      logger.info('No file uploaded');
      return res.status(400).send('Ningún archivo fue enviado.');
    }
    
    const filePath = req.file.path;
    logger.info(`Processing uploaded file: ${filePath}`);
    
    const data = await readCsvFile(filePath);
    const channelId = req.body.channel_id;
    
    await processCSVData(data, channelId);
    
    // Clean up - remove the file after processing
    fs.unlink(filePath, (err) => {
      if (err) logger.error(`Error deleting file: ${filePath}`, err);
    });
    
    res.status(200).send('¡Archivo procesado con éxito!');
  } catch (error) {
    logger.error('Error handling file upload', error);
    res.status(500).send(`Error al procesar el archivo: ${error.message}`);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// HEAD request handler for ping checks
app.head('/', (req, res) => {
  res.status(200).end();
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error', err);
  res.status(500).send({
    error: err.message || 'Internal Server Error'
  });
});

// Slack event listeners

// Listen for reactions to track confirmations
slackApp.event('reaction_added', async ({ event, context }) => {
  try {
    const { reaction, item, user } = event;

    if (reaction === 'white_check_mark' && sentMessages.has(item.ts)) {
      const { user: slackUserId, name } = sentMessages.get(item.ts);
      
      // Verify the user reacting is the same one the message was sent to
      if (slackUserId === user) {
        logger.info(`Confirmation received from ${name}`, { userId: slackUserId });
        
        // Send confirmation to the admin channel (em espanhol)
        await slackApp.client.chat.postMessage({
          channel: process.env.ADMIN_CHANNEL_ID || process.env.CHANNEL_ID,
          text: `El agente ${name} (<@${slackUserId}>) ha confirmado la recepción del salario y está de acuerdo con los valores.`,
        });
      }
    }
  } catch (error) {
    logger.error('Error handling reaction', error);
  }
});

// Listen for messages in DMs
slackApp.event('message', async ({ event, context, say }) => {
  try {
    // Skip if it's a bot message or doesn't have text
    if (event.bot_id || !event.text) return;
    
    // Check if the message is in a DM
    if (event.channel_type === 'im') {
      logger.info(`DM received from user`, { userId: event.user, text: event.text.substring(0, 50) });
      
      // Respond to the user (em espanhol)
      await say({
        text: `¡Hola! He recibido tu mensaje. Si tienes dudas sobre tu pago, por favor contacta a la supervisión.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "¡Hola! He recibido tu mensaje. Si tienes dudas sobre tu pago, por favor contacta a la supervisión."
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "Este es un sistema automatizado. Los mensajes enviados aquí no son monitoreados por personas."
              }
            ]
          }
        ]
      });
      
      // Forward the message to admins if configured
      if (process.env.FORWARD_DMS === 'true' && process.env.ADMIN_CHANNEL_ID) {
        await slackApp.client.chat.postMessage({
          channel: process.env.ADMIN_CHANNEL_ID,
          text: `Mensaje recibido de <@${event.user}>: "${event.text}"`,
        });
      }
    }
  } catch (error) {
    logger.error('Error handling message event', error);
  }
});

// Listen for file uploads
slackApp.event('file_shared', async ({ event, context }) => {
  try {
    const { file_id, channel_id } = event;

    // Se o arquivo já foi processado, ignora o reprocessamento
    if (processedFiles.has(file_id)) {
      console.log(`Archivo ${file_id} ya fue procesado, ignorando.`);
      return;
    }
    processedFiles.add(file_id);

    logger.info(`File shared`, { fileId: file_id, channelId: channel_id });

    // Get file info
    const fileInfo = await slackApp.client.files.info({ file: file_id });
    const file = fileInfo.file;
    
    // Process only CSV files
    if (file.filetype !== 'csv') {
      logger.info('Ignoring non-CSV file', { fileType: file.filetype });
      return;
    }
    
    // Download the file using axios instead of node-fetch
    const fileUrl = file.url_private_download;
    const fileName = `${Date.now()}-${file.name}`;
    const filePath = path.join(uploadDir, fileName);
    
    logger.info(`Downloading file`, { url: fileUrl, path: filePath });
    
    const response = await axios({
      method: 'get',
      url: fileUrl,
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });
    
    fs.writeFileSync(filePath, response.data);
    
    // Process the CSV file
    const data = await readCsvFile(filePath);
    await processCSVData(data, channel_id);
    
    // Clean up
    fs.unlinkSync(filePath);
    
  } catch (error) {
    logger.error('Error processing shared file', error);
    
    // Notify about the error (em espanhol)
    if (event.channel_id) {
      try {
        await slackApp.client.chat.postMessage({
          channel: event.channel_id,
          text: `❌ Error al procesar el archivo: ${error.message}`,
        });
      } catch (notifyError) {
        logger.error('Failed to send error notification', notifyError);
      }
    }
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    // Start the server
    await slackApp.start(PORT);
    logger.info(`⚡️ Slack Bolt app is running on port ${PORT}!`);
    logger.info('Server is ready to receive requests');
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
})();
