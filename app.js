require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');

// --- MELHORIA: CENTRALIZAÇÃO DE CONSTANTES ---
// Centraliza valores "mágicos" e configurações para facilitar a manutenção.
const CONSTANTS = {
  CONFIRMATION_REACTION: 'white_check_mark',
  MESSAGE_EXPIRATION_DAYS: 7, // Dias para remover uma mensagem do rastreamento
  PROCESSED_FILE_EXPIRATION_HOURS: 24, // Horas para remover um arquivo do rastreamento
};

const CSV_COLS = {
  SLACK_ID: 'Slack User',
  NAME: 'Name',
  SALARY: 'Salary',
  FALTAS: 'Faltas',
  FERIADOS: 'Feriados Trabalhados'
};

// --- Configuração de Diretório e Upload ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
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

// --- Inicialização do App Slack e Express ---
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

const app = receiver.app;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Armazenamento em Memória ---
const sentMessages = new Map();
const processedFiles = new Set();

// --- Funções Utilitárias ---
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
 * Rastreia uma mensagem e agenda sua remoção para evitar vazamento de memória.
 */
function trackMessage(timestamp, data) {
  const expirationMs = CONSTANTS.MESSAGE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
  sentMessages.set(timestamp, data);
  setTimeout(() => {
    sentMessages.delete(timestamp);
    logger.debug(`Entrada de mensagem expirada e removida: ${timestamp}`);
  }, expirationMs);
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

/**
 * Gera a mensagem de salário usando variáveis de ambiente para os e-mails.
 */
function generateMessage(name, salary, faltas = 0, feriadosTrabalhados = 0) {
    const faltasText = faltas === 1 ? `hubo *${faltas} ausencia*` : faltas > 1 ? `hubo *${faltas} ausencias*` : '*no hubo ausencias*';
    const feriadosText = feriadosTrabalhados === 1 ? `trabajó en *${feriadosTrabalhados} día festivo*` : feriadosTrabalhados > 1 ? `trabajó en *${feriadosTrabalhados} días festivos*` : '*no trabajó en ningún día festivo*';
    
    // --- MELHORIA: Usa variáveis de ambiente para os e-mails ---
    const coreEmails = process.env.CORE_EMAILS || 'corefone@domus.global';
    const supervisorEmails = process.env.SUPERVISOR_EMAILS || 'maximiliano.varin@corefone.us,guilherme.santos@corefone.us,mara.zuniga@corefone.us';

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

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores en el último día hábil del mes. Por favor, envíe la factura a *${coreEmails}*, con copia a *${supervisorEmails}*.

Por favor, confirma que has recibido este mensaje y estás de acuerdo con los valores anteriores reaccionando con un ✅ (*check*).

¡Agradecemos tu atención y te deseamos un excelente trabajo!
_Atentamente,_ 
*Supervisión Corefone AR/LATAM*
`;
}

async function processCSVData(data, channelId) {
  let messagesSent = 0;
  const reportDetails = [];
  const failedUsers = [];

  try {
    // Para CSVs muito grandes, o envio sequencial (await dentro do loop) é mais seguro
    // contra rate limits do Slack. Para otimizar a velocidade, poderia se usar
    // Promise.allSettled com um controle de concorrência (ex: processar em lotes de 10).
    for (const row of data) {
      const slackUserId = row[CSV_COLS.SLACK_ID];
      const agentName = row[CSV_COLS.NAME];
      const salary = parseFloat(row[CSV_COLS.SALARY]);

      // --- MELHORIA: Validação de dados mais rigorosa ---
      if (!slackUserId || !agentName || !slackUserId.startsWith('U') || isNaN(salary) || salary <= 0) {
        logger.info('Skipping row with invalid or missing data', { row });
        failedUsers.push(agentName || `Linha desconhecida (dados inválidos)`);
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
        
        reportDetails.push(`• *${agentName}:* Salario: US$${salary}, Ausencias: ${faltas}, Días Festivos: ${feriadosTrabalhados}`);
        
        trackMessage(result.ts, {
          user: slackUserId,
          name: agentName,
        });

      } catch (error) {
        logger.error(`Failed to send message to ${agentName} (${slackUserId})`, error);
        failedUsers.push(agentName);
      }
    }

    // Lógica para enviar o relatório final (sem alterações)
    if (channelId) {
        let confirmationText = `¡Archivo procesado! ✅ Mensajes enviados: ${messagesSent}/${data.length}.`;
        
        if (failedUsers.length > 0) {
            confirmationText += `\n\n❌ *No se pudo enviar mensaje a:* ${failedUsers.join(', ')}.`;
        }

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

// --- Middlewares e Endpoints Express ---

/**
 * --- MELHORIA DE SEGURANÇA: Middleware de Autenticação ---
 * Protege o endpoint de upload com um token secreto.
 */
const requireUploadToken = (req, res, next) => {
    const token = req.headers['x-upload-token'];
    if (token && token === process.env.UPLOAD_SECRET_TOKEN) {
      return next();
    }
    res.status(401).send({ error: 'Unauthorized' });
};

// Se este endpoint não for utilizado, considere removê-lo para diminuir a superfície de ataque.
app.post('/upload', requireUploadToken, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send({ error: 'No file uploaded.' });
    }
    try {
        const data = await readCsvFile(req.file.path);
        // O channelId não está disponível aqui, então o relatório não será postado no Slack.
        // Se precisar do relatório, o ID do canal deve ser enviado no corpo da requisição.
        await processCSVData(data, req.body.channel_id || null);
        fs.unlinkSync(req.file.path); // Limpa o arquivo após o uso
        res.status(200).send({ message: 'File processed successfully.' });
    } catch (error) {
        res.status(500).send({ error: `Failed to process file: ${error.message}` });
    }
});

app.get('/', (req, res) => res.status(200).send({ status: 'healthy', uptime: process.uptime() }));
app.head('/', (req, res) => res.status(200).end());

app.use((err, req, res, next) => {
  logger.error('Express error', err);
  res.status(500).send({ error: err.message || 'Internal Server Error' });
});

// --- Listeners de Eventos Slack ---

slackApp.event('reaction_added', async ({ event }) => {
  try {
    const { reaction, item, user } = event;

    if (reaction === CONSTANTS.CONFIRMATION_REACTION && sentMessages.has(item.ts)) {
      const { user: slackUserId, name } = sentMessages.get(item.ts);
      
      if (slackUserId === user) {
        logger.info(`Confirmation received from ${name}`, { userId: slackUserId });
        
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

slackApp.event('file_shared', async ({ event }) => {
  let filePath; // Declarado aqui para ser acessível no bloco `finally`

  try {
    const { file_id, channel_id } = event;

    if (processedFiles.has(file_id)) {
      logger.info(`File ${file_id} already processed, ignoring.`);
      return;
    }
    processedFiles.add(file_id);
    const expirationMs = CONSTANTS.PROCESSED_FILE_EXPIRATION_HOURS * 60 * 60 * 1000;
    setTimeout(() => processedFiles.delete(file_id), expirationMs);

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
    
    filePath = path.join(uploadDir, `${Date.now()}-${file.name}`);
    fs.writeFileSync(filePath, response.data);
    
    const data = await readCsvFile(filePath);
    await processCSVData(data, channel_id);
    
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
  } finally {
    // --- MELHORIA: Garante que o arquivo temporário seja sempre deletado ---
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Temporary file deleted: ${filePath}`);
    }
  }
});

// --- Inicialização do Servidor ---
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
