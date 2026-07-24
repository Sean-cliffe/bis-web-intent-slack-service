const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 10000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;

app.use('/hubspot/web-intent', express.json());

// Capture RAW body for Slack signature verification
app.use('/slack/interactions', express.urlencoded({
  extended: true,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

function verifySlackSignature(req) {
  const slackSignature = req.headers['x-slack-signature'];
  const slackTimestamp = req.headers['x-slack-request-timestamp'];

  if (!slackSignature || !slackTimestamp || !req.rawBody) {
    return false;
  }

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(slackTimestamp) < fiveMinutesAgo) {
    return false;
  }

  const baseString = `v0:${slackTimestamp}:${req.rawBody}`;
  const hmac = crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex');

  const computedSignature = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature, 'utf8'),
      Buffer.from(slackSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

async function updateHubSpotCompany(companyId, decision) {
  const url = `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`;

  return axios.patch(
    url,
    {
      properties: {
        slack_follow_up_status: decision
      }
    },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

app.post('/slack/interactions', async (req, res) => {
  try {
    if (!verifySlackSignature(req)) {
      return res.status(401).send('Invalid Slack signature');
    }

    const payload = JSON.parse(req.body.payload);
    const action = payload.actions?.[0];

    if (!action?.value) {
      return res.status(400).send('Missing action value');
    }

    const { companyId, decision } = JSON.parse(action.value);

    await updateHubSpotCompany(companyId, decision);

    return res.json({
      replace_original: true,
      text: `Decision recorded: ${decision}`
    });
  } catch (error) {
    console.error('Slack interaction error:', error.response?.data || error.message);
    return res.status(500).send('Failed to process interaction');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

function buildSlackMessage({ companyId, companyName, alertType }) {
  return {
    channel: SLACK_CHANNEL_ID,
    text: 'BIS web intent alert',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*BIS web intent alert*\n` +
            `*Company:* ${companyName || 'Unknown company'}\n` +
            `*Alert type:* ${alertType || 'Unknown alert'}\n` +
            `Would you like to follow up with this company?`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Yes'
            },
            style: 'primary',
            action_id: 'follow_up_yes',
            value: JSON.stringify({ companyId, decision: 'Yes' })
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'No'
            },
            style: 'danger',
            action_id: 'follow_up_no',
            value: JSON.stringify({ companyId, decision: 'No' })
          }
        ]
      }
    ]
  };
}

async function postToSlack(messagePayload) {
  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    messagePayload,
    {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    }
  );

  if (!response.data.ok) {
    throw new Error(`Slack API error: ${response.data.error}`);
  }

  return response.data;
}

async function updateHubSpotCompany(companyId, decision) {
  const url = `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`;

  const body = {
    properties: {
      slack_follow_up_status: decision
    }
  };

  const response = await axios.patch(url, body, {
    headers: {
      Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

function verifySlackSignature(req) {
  const slackSignature = req.headers['x-slack-signature'];
  const slackTimestamp = req.headers['x-slack-request-timestamp'];

  if (!slackSignature || !slackTimestamp) return false;

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(slackTimestamp) < fiveMinutesAgo) return false;

  const rawBody = new URLSearchParams(req.body).toString();
  const baseString = `v0:${slackTimestamp}:${rawBody}`;

  const hmac = crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex');

  const computedSignature = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature, 'utf8'),
      Buffer.from(slackSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

// 1) HubSpot -> this service
app.post('/hubspot/web-intent', async (req, res) => {
  try {
    const {
      companyId,
      companyName,
      alertType
    } = req.body;

    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    const slackPayload = buildSlackMessage({
      companyId,
      companyName,
      alertType
    });

    const slackResponse = await postToSlack(slackPayload);

    return res.status(200).json({
      success: true,
      channel: slackResponse.channel,
      messageTs: slackResponse.ts
    });
  } catch (error) {
    console.error('Error in /hubspot/web-intent:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// 2) Slack button clicks -> this service
app.post('/slack/interactions', async (req, res) => {
  try {
    if (!verifySlackSignature(req)) {
      return res.status(401).send('Invalid Slack signature');
    }

    const payload = JSON.parse(req.body.payload);
    const action = payload.actions && payload.actions[0];

    if (!action || !action.value) {
      return res.status(400).send('Missing action payload');
    }

    const { companyId, decision } = JSON.parse(action.value);

    await updateHubSpotCompany(companyId, decision);

    return res.json({
      replace_original: true,
      text: `Decision recorded: ${decision}`
    });
  } catch (error) {
    console.error('Error in /slack/interactions:', error.response?.data || error.message);
    return res.status(500).send('Failed to process interaction');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
