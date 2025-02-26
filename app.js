require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');

// Configuração do servidor Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializa o Slack Bolt App
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Armazena mensagens enviadas
const sentMessages = {};

// Middleware para processar JSON
app.use(express.json());

// Rota para upload de CSV
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No se ha enviado ningún archivo.');
  }

  try {
    const filePath = req.file.path;
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

    fs.unlinkSync(filePath);
    res.status(200).send('¡Hoja de cálculo procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la hoja de cálculo:', error);
    res.status(500).send('Error al procesar la hoja de cálculo.');
  }
});

// Função para ler CSV
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

// Função para gerar mensagem
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
  return `
:wave: *¡Hola, ${name}!*
Esperamos que estés bien. Te compartimos los detalles de tu salario de este mes.

*Valor del salario a pagar:* US$${salary}

*Detalles adicionales:*
• Faltas: ${faltas}.
• Feriados trabajados: ${feriadosTrabalhados}.

Por favor, confirma con un ✅.
`;
}

// Evento de reação
slackApp.event('reaction_added', async ({ event }) => {
  console.log('Reação detectada:', event);

  const { reaction, item } = event;
  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `Agente ${name} (@${slackUserId}) confirmó la recepción.`,
    });
  }
});

// Evento para capturar arquivos
slackApp.event('file_shared', async ({ event }) => {
  console.log('Arquivo recebido:', event);
});

// Configuração do servidor Express e Bolt
const PORT = process.env.PORT || 3000;
(async () => {
  await slackApp.start(PORT);
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
})();
