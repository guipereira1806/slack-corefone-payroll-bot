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
    console.error('Error al
