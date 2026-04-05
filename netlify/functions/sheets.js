const { google } = require('googleapis');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '伺服器未設定 GOOGLE_SERVICE_ACCOUNT 環境變數' }) };
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  } catch {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT 格式錯誤，需為合法 JSON' }) };
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheetsApi = google.sheets({ version: 'v4', auth });

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '無效的請求內容' }) };
  }

  const { action, spreadsheetId } = body;
  if (!spreadsheetId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 spreadsheetId' }) };
  }

  try {
    let result;

    switch (action) {
      case 'get': {
        const res = await sheetsApi.spreadsheets.values.get({
          spreadsheetId,
          range: body.range,
        });
        result = res.data;
        break;
      }
      case 'update': {
        const res = await sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range: body.range,
          valueInputOption: 'RAW',
          requestBody: { values: body.values },
        });
        result = res.data;
        break;
      }
      case 'clear': {
        const res = await sheetsApi.spreadsheets.values.clear({
          spreadsheetId,
          range: body.range,
        });
        result = res.data;
        break;
      }
      case 'getMetadata': {
        const res = await sheetsApi.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets.properties',
        });
        result = res.data;
        break;
      }
      case 'addSheet': {
        const res = await sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: body.title } } }],
          },
        });
        result = res.data;
        break;
      }
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: `未知的 action: ${action}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || '未知錯誤';
    return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
  }
};
