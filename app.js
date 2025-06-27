require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');

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

// Create the ExpressReceiver and Slack App
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

// Access the Express app
const app = receiver.app;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- MELHORIA 2: CENTRALIZAÇÃO DE CONSTANTES ---
// Centraliza os nomes das colunas do CSV para facilitar a manutenção.
const CSV_COLS = {
  SLACK_ID: 'Slack User',
  NAME: 'Name',
  SALARY: 'Salary',
  FALTAS: 'Faltas',
  FERIADOS: 'Feriados Trabalhados'
};

// Store sent messages for tracking reactions
const sentMessages = new Map();
const processedFiles = new Set();

// Utility functions
const logger = {
  info: (message, data = {}) => console.log(`[INFO] ${message}`, data),
  error: (message, error) => console.error(`[ERROR] ${message}`, error),
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.debug(`[DEBUG] ${message}`, data);
    }
  }
};

/**
 * --- MELHORIA 1: PREVENÇÃO DE VAZAMENTO DE MEMÓRIA ---
 * Rastreia uma mensagem e agenda sua remoção para evitar que o mapa `sentMessages` cresça indefinidamente.
 */
function trackMessage(timestamp, data) {
    const MESSAGE_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
    sentMessages.set(timestamp, data);
    setTimeout(() => {
        sentMessages.delete(timestamp);
        logger.debug(`Entrada de mensagem expirada e removida: ${timestamp}`);
    }, MESSAGE_EXPIRATION_MS);
}

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

function generateMessage(name, salary, faltas = 0, feriadosTrabalhados = 0) {
    // ... (Sua função original aqui, sem alterações)
    const faltasText = faltas === 1 ? `hubo *${faltas} ausencia*` : faltas > 1 ? `hubo *${faltas} ausencias*` : '*no hubo ausencias*';
    const feriadosText = feriadosTrabalhados === 1 ? `trabajó en *${feriadosTrabalhados} día festivo*` : feriadosTrabalhados > 1 ? `trabajó en *${feriadosTrabalhados} días festivos*` : '*no trabajó en ningún día festivo*';
    return `:wave: *¡Hola, ${name}!*
Esperamos que estés bien. Pasamos por aquí para compartir los detalles de tu salario correspondiente a este mes.

*Valor del salario a pagar este mes:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse en el _último día hábil del mes_.
• Al emitir la factura, incluye el mes de referencia. Sigue un ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoramiento de atención al cliente 
  \`\`\`

*Detalles adicionales:*
• Ausencias: ${faltasText}.
• Días festivos trabajados: ${feriadosText}.

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores en el último día hábil del mes. Por favor, envíe la factura a *corefone@domus.global*, con copia a *administracion@corefone.us*, *gilda.romero@corefone.us* y a los supervisores *maximiliano.varin@corefone.us*, *guilherme.santos@corefone.us* y *agustin.gonzalez@corefone.us*.

Por favor, confirma que has recibido este mensaje y estás de acuerdo con los valores anteriores reaccionando con un ✅ (*check*).

¡Agradecemos tu atención y te deseamos un excelente trabajo!
_Atentamente,_ 
*Supervisión Corefone AR/LATAM*
`;
}

async function processCSVData(data, channelId) {
  let messagesSent = 0;
  // --- MELHORIA 3 e 4: MELHORIA NO RELATÓRIO ---
  const reportDetails = []; // Para o relatório detalhado
  const failedUsers = [];   // Para listar usuários que falharam

  try {
    for (const row of data) {
      // Usa as constantes definidas no topo
      const slackUserId = row[CSV_COLS.SLACK_ID];
      const salary = row[CSV_COLS.SALARY];
      const agentName = row[CSV_COLS.NAME];
      
      if (!slackUserId || !salary) {
        logger.info('Skipping row with missing Slack User ID or salary', { row });
        if(agentName) failedUsers.push(agentName);
        continue;
      }

      const faltas = parseInt(row[CSV_COLS.FALTAS] || 0);
      const feriadosTrabalhados = parseInt(row[CSV_COLS.FERIADOS] || 0);

      try {
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: message,
        });
        
        logger.info(`Message sent to ${agentName}`, { userId: slackUserId });
        messagesSent++;
        
        // Adiciona ao relatório detalhado
        reportDetails.push(`• *${agentName}:* Salario: US$${salary}, Ausencias: ${faltas}, Días Festivos: ${feriadosTrabalhados}`);
        
        // Usa a nova função para rastrear a mensagem com expiração
        trackMessage(result.ts, {
          user: slackUserId,
          name: agentName,
        });

      } catch (error) {
        logger.error(`Failed to send message to ${agentName} (${slackUserId})`, error);
        failedUsers.push(agentName);
      }
    }

    if (channelId) {
        let confirmationText = `¡Archivo procesado! ✅ Mensajes enviados: ${messagesSent}/${data.length}.`;
        
        if (failedUsers.length > 0) {
            confirmationText += `\n\n❌ *No se pudo enviar mensaje a:* ${failedUsers.join(', ')}.`;
        }

        // Se o relatório for muito grande, envia como um anexo "snippet"
        if (reportDetails.length > 20) {
            confirmationText += `\n\nUn resumen detallado fue enviado como archivo adjunto.`;
            await slackApp.client.files.uploadV2({
                channel_id: channelId,
                content: `Detalles de Salarios Enviados:\n\n${reportDetails.join('\n')}`,
                title: "Reporte de Salarios",
                filename: "reporte_detallado.txt"
            });
        } else if (reportDetails.length > 0) {
            confirmationText += `\n\n*Detalles enviados:*\n${reportDetails.join('\n')}`;
        }

      await slackApp.client.chat.postMessage({
        channel: channelId,
        text: confirmationText,
      });
    }
    
    return messagesSent;
  } catch (error) {
    logger.error('Error processing CSV data', error);
    throw error;
  }
}

// Endpoint de upload (sem mudanças significativas)
app.post('/upload', upload.single('file'), async (req, res) => {
    // ...
});

// Health check endpoints (sem mudanças)
app.get('/', (req, res) => res.status(200).send({ status: 'healthy', uptime: process.uptime() }));
app.head('/', (req, res) => res.status(200).end());

// Error handling middleware (sem mudanças)
app.use((err, req, res, next) => {
  logger.error('Express error', err);
  res.status(500).send({ error: err.message || 'Internal Server Error' });
});

// --- SLACK EVENT LISTENERS ---

slackApp.event('reaction_added', async ({ event }) => {
  try {
    const { reaction, item, user } = event;

    if (reaction === 'white_check_mark' && sentMessages.has(item.ts)) {
      const { user: slackUserId, name } = sentMessages.get(item.ts);
      
      if (slackUserId === user) {
        logger.info(`Confirmation received from ${name}`, { userId: slackUserId });
        
        // SUGESTÃO: Use uma variável de ambiente mais específica para este canal
        const adminChannel = process.env.ADMIN_CHANNEL_ID || process.env.CHANNEL_ID;
        await slackApp.client.chat.postMessage({
          channel: adminChannel,
          text: `El agente ${name} (<@${slackUserId}>) ha confirmado la recepción del salario y está de acuerdo con los valores.`,
        });
      }
    }
  } catch (error) {
    logger.error('Error handling reaction', error);
  }
});

slackApp.event('message', async ({ event, say }) => {
    // ... (Sua lógica original aqui, sem alterações)
});

slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;

    if (processedFiles.has(file_id)) {
      console.log(`Archivo ${file_id} ya fue procesado, ignorando.`);
      return;
    }
    processedFiles.add(file_id);
    // Adiciona uma limpeza periódica ao Set também, para o caso de o app rodar por muito tempo
    setTimeout(() => processedFiles.delete(file_id), 24 * 60 * 60 * 1000); // Limpa após 24h

    logger.info(`File shared`, { fileId: file_id, channelId: channel_id });
    const fileInfo = await slackApp.client.files.info({ file: file_id });
    const file = fileInfo.file;
    
    if (file.filetype !== 'csv') {
      logger.info('Ignoring non-CSV file', { fileType: file.filetype });
      return;
    }
    
    const response = await axios({
      method: 'get',
      url: file.url_private_download,
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    
    const filePath = path.join(uploadDir, `${Date.now()}-${file.name}`);
    fs.writeFileSync(filePath, response.data);
    
    const data = await readCsvFile(filePath);
    await processCSVData(data, channel_id);
    
    fs.unlinkSync(filePath);
    
  } catch (error) {
    logger.error('Error processing shared file', error);
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
    await slackApp.start(PORT);
    logger.info(`⚡️ Slack Bolt app is running on port ${PORT}!`);
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
})();
