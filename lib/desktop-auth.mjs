/**
 * 从 Qoder 桌面客户端读取已登录凭证。
 *
 * 客户端把凭证用 Electron safeStorage 加密后写到 `<userData>/auth.v1.dat`：
 *   'v10' + AES-256-GCM(nonce[12] + ciphertext + tag[16])
 * key 来自 `<userData>/Local State` 的 os_crypt.encrypted_key：
 *   base64 → 去 "DPAPI" 5 字节 → CryptUnprotectData(当前用户)
 *
 * Windows 上没有 Node 原生的 DPAPI 绑定，这一步只能交给 PowerShell 跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** 两个客户端的 userData 目录（相对 %APPDATA%）。 */
export const DESKTOP_DIRS = {
  cn: 'com.qodercn.app.stable',
  intl: 'com.qoder.app.stable',
};

function appDataDir() {
  return process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
}

/** DPAPI 解出 32 字节 AES key。 */
function unprotectKey(encryptedKeyB64) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${encryptedKeyB64}')`,
    '$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    "($k | ForEach-Object { $_.ToString('x2') }) -join ''",
  ].join('; ');
  const hex = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 20000,
  }).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('DPAPI 解 key 失败');
  return Buffer.from(hex, 'hex');
}

function decryptV10(key, raw) {
  if (raw.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('auth.v1.dat 不是 v10 格式');
  const body = raw.subarray(3);
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(12, body.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * 读一个客户端 app 的登录态。
 * @param realm - 'cn' | 'intl'
 * @returns { realm, dir, token, refreshToken, user } 或 null（未登录）
 */
export function readDesktopAuth(realm) {
  const name = DESKTOP_DIRS[realm];
  if (!name) throw new Error(`未知区域: ${realm}`);
  const dir = path.join(appDataDir(), name);
  const authFile = path.join(dir, 'auth.v1.dat');
  const stateFile = path.join(dir, 'Local State');
  if (!fs.existsSync(authFile) || !fs.existsSync(stateFile)) return null;

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const encKey = state?.os_crypt?.encrypted_key;
  if (typeof encKey !== 'string') return null;

  const blob = Buffer.from(encKey, 'base64');
  if (blob.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('os_crypt.encrypted_key 前缀不是 DPAPI');
  const key = unprotectKey(blob.subarray(5).toString('base64'));

  const payload = JSON.parse(decryptV10(key, fs.readFileSync(authFile)));
  if (!payload?.token) return null;

  return {
    realm,
    dir,
    token: payload.token,
    refreshToken: payload.refreshToken ?? '',
    expiresAt: payload.expiresAt ?? null,
    user: payload.user ?? null,
  };
}

/** 两个区域都扫一遍，只返回已登录的。 */
export function readAllDesktopAuth() {
  const out = [];
  for (const realm of Object.keys(DESKTOP_DIRS)) {
    try {
      const hit = readDesktopAuth(realm);
      if (hit) out.push(hit);
    } catch {
      /* 某个区域没装或没登录，跳过 */
    }
  }
  return out;
}
