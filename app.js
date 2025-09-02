require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
// const multer = require('multer'); // <<< REMOVIDO
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');

// --- CONSTANTES E CONFIGURAÇÕES ---
const CONSTANTS = {
  CONFIRMATION_REACTION: 'white_check_mark',
  MESSAGE_EXPIRATION_DAYS: 7,
  PROCESSED_FILE_EXPIRATION_HOURS: 24,
};

const CSV_COLS = {
  SLACK_ID: 'Slack User',
  NAME: 'Name',
  SALARY: 'Salary',
  FALTAS: 'Faltas',
  FERIADOS: 'Feriados Trabalhados'
};

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// --- INICIALIZAÇÃO DO APP ---
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

// --- ESTADO E UTILITÁRIOS ---
const sentMessages = new Map();
const processedFiles = new Set();
const logger = {
  info: (message, data = {}) => console.log(`[INFO] ${message}`, data),
  error: (message, error) => console.error(`[ERROR] ${message}`, error),
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.debug(`[DEBUG] ${message}`, data);
    }
  }
};

function trackMessage(timestamp, data) {
  const expirationMs = CONSTANTS.MESSAGE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
  sentMessages.set(timestamp, data);
  setTimeout(() => {
    sentMessages.delete(timestamp);
    logger.debug(`Entrada de mensagem expirada e removida: ${timestamp}`);
  }, expirationMs);
}

// <<< MELHORIA: Função de leitura de CSV agora valida os cabeçalhos ---
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const data = [];
    const expectedHeaders = new Set(Object.values(CSV_COLS));
    const stream = fs.createReadStream(filePath).pipe(csv());

    stream.on('headers', (headers) => {
        const missingHeaders = [...expectedHeaders].filter(h => !headers.includes(h));
        if (missingHeaders.length > 0) {
            const err = new Error(`Cabeçalhos obrigatórios ausentes no CSV: ${missingHeaders.join(', ')}`);
            err.code = 'INVALID_HEADERS';
            stream.destroy(); // Para o processamento
            return reject(err);
        }
    });

    stream.on('data', (row) => data.push(row));
    stream.on('end', () => {
        logger.info(`CSV file successfully processed: ${filePath}`, { rowCount: data.length });
        resolve(data);
    });
    stream.on('error', (error) => {
        logger.error(`Error reading CSV file: ${filePath}`, error);
        reject(error);
    });
  });
}

// ... (Sua função generateMessage original aqui, sem alterações)
function generateMessage(name, salary, faltas = 0, feriadosTrabalhados = 0) {
    const faltasText = faltas === 1 ? `hubo *${faltas} ausencia*` : faltas > 1 ? `hubo *${faltas} ausencias*` : '*no hubo ausencias*';
    const feriadosText = feriadosTrabalhados === 1 ? `trabajó en *${feriadosTrabalhados} día festivo*` : feriadosTrabalhados > 1 ? `trabajó en *${feriadosTrabalhados} días festivos*` : '*no trabajó en ningún día festivo*';
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
    // ... (Sua função processCSVData original aqui, sem alterações)
    // Apenas para garantir que o código completo esteja aqui.
    let messagesSent = 0;
    const reportDetails = [];
    const failedUsers = [];
    try {
        for (const row of data) {
            const slackUserId = row[CSV_COLS.SLACK_ID];
            const agentName = row[CSV_COLS.NAME];
            const salary = parseFloat(row[CSV_COLS.SALARY]);
            if (!slackUserId || !agentName || !slackUserId.startsWith('U') || isNaN(salary) || salary <= 0) {
                logger.info('Skipping row with invalid or missing data', { row });
                failedUsers.push(agentName || `Linha desconhecida (dados inválidos)`);
                continue;
            }
            const faltas = parseInt(row[CSV_COLS.FALTAS] || 0);
            const feriadosTrabalhados = parseInt(row[CSV_COLS.FERIADOS] || 0);
            try {
                const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
                const result = await slackApp.client.chat.postMessage({ channel: slackUserId, text: message });
                logger.info(`Message sent to ${agentName}`, { userId: slackUserId });
                messagesSent++;
                reportDetails.push(`• *${agentName}:* Salario: US$${salary}, Ausencias: ${faltas}, Días Festivos: ${feriadosTrabalhados}`);
                trackMessage(result.ts, { user: slackUserId, name: agentName });
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
            if (reportDetails.length > 20) {
                confirmationText += `\n\nUn resumen detallado fue enviado como archivo adjunto.`;
                await slackApp.client.files.uploadV2({ channel_id: channelId, content: `Detalles de Salarios Enviados:\n\n${reportDetails.join('\n')}`, title: "Reporte de Salarios", filename: "reporte_detallado.txt" });
            } else if (reportDetails.length > 0) {
                confirmationText += `\n\n*Detalles enviados:*\n${reportDetails.join('\n')}`;
            }
            await slackApp.client.chat.postMessage({ channel: channelId, text: confirmationText });
        }
        return messagesSent;
    } catch (error) {
        logger.error('Error processing CSV data', error);
        throw error;
    }
}


// --- ENDPOINTS E MIDDLEWARES ---
app.get('/', (req, res) => res.status(200).send({ status: 'healthy', uptime: process.uptime() }));
app.head('/', (req, res) => res.status(200).end());

// <<< REMOVIDO: Todo o endpoint app.post('/upload') foi removido.
// O middleware requireUploadToken e a configuração do multer também foram deletados.

app.use((err, req, res, next) => {
  logger.error('Express error', err);
  res.status(500).send({ error: err.message || 'Internal Server Error' });
});

// --- LISTENERS DE EVENTOS SLACK ---
slackApp.event('reaction_added', async ({ event }) => {
  // ... (Sua lógica de reaction_added original aqui, sem alterações)
  try {
    const { reaction, item, user } = event;
    if (reaction === CONSTANTS.CONFIRMATION_REACTION && sentMessages.has(item.ts)) {
      const { user: slackUserId, name } = sentMessages.get(item.ts);
      if (slackUserId === user) {
        logger.info(`Confirmation received from ${name}`, { userId: slackUserId });
        const adminChannel = process.env.ADMIN_CHANNEL_ID || process.env.CHANNEL_ID;
        await slackApp.client.chat.postMessage({ channel: adminChannel, text: `El agente ${name} (<@${slackUserId}>) ha confirmado la recepción del salario y está de acuerdo con los valores.` });
      }
    }
  } catch (error) {
    logger.error('Error handling reaction', error);
  }
});

slackApp.event('file_shared', async ({ event }) => {
  let filePath;
  try {
    const { file_id, channel_id } = event;
    if (processedFiles.has(file_id)) {
      logger.info(`File ${file_id} already processed, ignoring.`);
      return;
    }
    processedFiles.add(file_id);
    const expirationMs = CONSTANTS.PROCESSED_FILE_EXPIRATION_HOURS * 60 * 60 * 1000;
    setTimeout(() => processedFiles.delete(file_id), expirationMs);

    const fileInfo = await slackApp.client.files.info({ file: file_id });
    if (fileInfo.file.filetype !== 'csv') {
      logger.info('Ignoring non-CSV file', { fileType: fileInfo.file.filetype });
      return;
    }

    // <<< MELHORIA: Download do arquivo otimizado usando streams ---
    const response = await axios({
      method: 'get',
      url: fileInfo.file.url_private_download,
      responseType: 'stream', // Mais eficiente para arquivos grandes
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });

    filePath = path.join(uploadDir, `${Date.now()}-${fileInfo.file.name}`);
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    
    const data = await readCsvFile(filePath);
    await processCSVData(data, channel_id);

  } catch (error) {
    logger.error('Error processing shared file', error);
    let errorMessage = `❌ Error al procesar el archivo: ${error.message}`;
    if (error.code === 'INVALID_HEADERS') {
        errorMessage = `❌ Error de formato: ${error.message}`;
    }
    
    if (event.channel_id) {
      try {
        await slackApp.client.chat.postMessage({ channel: event.channel_id, text: errorMessage });
      } catch (notifyError) {
        logger.error('Failed to send error notification', notifyError);
      }
    }
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Temporary file deleted: ${filePath}`);
    }
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
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
