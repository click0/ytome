/**
 * Спільна автентифікація Google (Service Account).
 *
 * Використовується Drive та Sheets. Потрібно:
 *   1. Створити Service Account у Google Cloud Console → IAM
 *   2. Завантажити JSON-ключ, вказати шлях у GOOGLE_SERVICE_ACCOUNT_KEY_FILE
 *   3. Розшарити цільову папку/таблицю на email сервіс-акаунта
 */
import { google } from 'googleapis';
import fs from 'fs';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];

let _auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;

export function googleAuthAvailable(): boolean {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  return !!keyFile && fs.existsSync(keyFile);
}

export function getGoogleAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY_FILE not set. ' +
      'Create a service account at console.cloud.google.com → IAM → Service Accounts, ' +
      'download the JSON key, and set the path in .env'
    );
  }
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Service account key file not found: ${keyFile}`);
  }
  if (!_auth) {
    _auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  }
  return _auth;
}

export function getDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleAuth() as any });
}

export function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleAuth() as any });
}
