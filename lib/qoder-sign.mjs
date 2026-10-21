/**
 * Qoder COSY 签名层（Node 移植版）
 *
 * 逻辑来自 qoder2api-hub 的 qoder_sign.py / qoder_fingerprint.py，
 * 那边是纯 Python 手写 AES/RSA；Node 的 crypto 自带这些，所以只需搬计算流程：
 *
 *   temp_key = uuid4().hex[:16]                   16 ASCII → AES-128 key/iv
 *   cosy_key = base64(RSA_PKCS1v15(temp_key))
 *   info     = base64(AES_CBC(sorted_json(identity), temp_key, temp_key))
 *   raw      = payload_b64 \n cosy_key \n date \n body \n path
 *   bearer   = "Bearer COSY." + payload_b64 + "." + md5(raw)
 */
import crypto from 'node:crypto';

/** Qoder 自定义 Base64：标准表 + 三段轮转（尾/中/首）+ 自定义字母表，'=' → '$' */
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const PAD = '$';

const STD2CUSTOM = new Map([...STD].map((c, i) => [c, CUSTOM[i]]));
std2custom_setup: {
  STD2CUSTOM.set('=', PAD);
}

export function qoderEncode(plain) {
  const std = Buffer.from(plain).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) out += STD2CUSTOM.get(ch) ?? ch;
  return out;
}

export function qoderDecode(encoded) {
  const custom2std = new Map([...CUSTOM].map((c, i) => [c, STD[i]]));
  custom2std.set(PAD, '=');
  let std = '';
  for (const ch of encoded) std += custom2std.get(ch) ?? ch;
  const n = std.length;
  const a = Math.floor(n / 3);
  const r1 = std.slice(0, a);
  const r2 = std.slice(a, n - a);
  const r3 = std.slice(n - a);
  return Buffer.from(r3 + r2 + r1, 'base64');
}

/** 键排序 + 无空白的紧凑 JSON。服务端签名对这些字节敏感。 */
export function sortedJsonCompact(obj) {
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(String(k))}:${JSON.stringify(obj[k] ?? '')}`);
  return `{${parts.join(',')}}`;
}

/** 按 uid + salt 稳定派生 UUIDv4 形态的设备标识（版本位 4、变体位 a）。 */
export function deriveId(uid, salt) {
  const seed = `${salt}:${uid || 'anonymous'}`;
  let h = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  h = h.slice(0, 12) + '4' + h.slice(13, 16) + 'a' + h.slice(17);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function deriveMachineType(uid) {
  return deriveId(uid, 'machinetype').replace(/-/g, '').slice(0, 18);
}

export function deriveMachineToken(uid) {
  const raw = crypto.createHash('sha512').update(`machinetoken:${uid}`, 'utf8').digest();
  return raw.toString('base64url').slice(0, 43);
}

export function machineHostname(uid) {
  const h = crypto.createHash('md5').update(`hostname:${uid || 'anonymous'}`, 'utf8').digest('hex');
  return 'DESKTOP-' + h.slice(0, 7).toUpperCase();
}

/** 官方客户端内置的 RSA 公钥（SPKI PEM）。 */
export const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export const COSY_VERSION = '1.1.64';
export const DEFAULT_USER_TYPE = 'personal_professional_trial';

function rsaPkcs1v15Encrypt(plain) {
  return crypto.publicEncrypt(
    { key: SERVER_PUB_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plain),
  );
}

function aesCbcEncrypt(plain, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** 单账号的 COSY 签名会话。access token 轮换后应重建。 */
export class CosySession {
  constructor({
    uid,
    nickname = '',
    accessToken = '',
    refreshToken = '',
    userType = DEFAULT_USER_TYPE,
    orgId = '',
    orgName = '',
  }) {
    this.uid = uid || '';
    this.machineId = deriveId(this.uid, 'machine');
    this.machineToken = deriveMachineToken(this.uid);
    this.machineType = deriveMachineType(this.uid);
    this.machineHostname = machineHostname(this.uid);
    this.accessToken = accessToken || '';

    this.tempKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    this.cosyKey = rsaPkcs1v15Encrypt(this.tempKey).toString('base64');

    const identity = {
      name: nickname || '',
      aid: this.uid,
      uid: this.uid,
      yx_uid: '',
      organization_id: orgId || '',
      organization_name: orgName || '',
      user_type: userType || DEFAULT_USER_TYPE,
      security_oauth_token: accessToken || '',
      refresh_token: refreshToken || '',
    };
    const plain = Buffer.from(sortedJsonCompact(identity), 'utf8');
    const keyBuf = Buffer.from(this.tempKey, 'utf8');
    this.info = aesCbcEncrypt(plain, keyBuf, keyBuf).toString('base64');
  }

  /** 返回 [payloadB64, date, bearer]。签名覆盖 body 与去掉 /algo 前缀的 path。 */
  bearer(body, rawUrl) {
    let path = '/';
    try {
      path = new URL(rawUrl).pathname || '/';
    } catch {
      path = rawUrl.split('?')[0] || '/';
    }
    if (path.startsWith('/algo')) path = path.slice('/algo'.length);

    const payload = {
      cosyVersion: COSY_VERSION,
      ideVersion: '',
      info: this.info,
      requestId: crypto.randomUUID(),
      version: 'v1',
    };
    const payloadB64 = Buffer.from(sortedJsonCompact(payload), 'utf8').toString('base64');
    const date = String(Math.floor(Date.now() / 1000));
    const raw = [payloadB64, this.cosyKey, date, body, path].join('\n');
    const sig = crypto.createHash('md5').update(raw, 'utf8').digest('hex');
    return [payloadB64, date, `Bearer COSY.${payloadB64}.${sig}`];
  }

  /** 构造一次推理请求的完整 COSY 头。 */
  headers(body, rawUrl, { modelKey = '', sse = true } = {}) {
    const [, date, bearer] = this.bearer(body, rawUrl);
    const h = {
      'cosy-data-policy': 'AGREE',
      'content-type': 'application/json',
      'cosy-machinetype': this.machineType,
      'cosy-clienttype': '5',
      'cosy-date': date,
      'cosy-user': this.uid,
      'cosy-key': this.cosyKey,
      accept: sse ? 'text/event-stream' : 'application/json',
      'cosy-clientip': '169.254.198.161',
      authorization: bearer,
      'accept-encoding': 'identity',
      'cosy-version': COSY_VERSION,
      'cosy-machineid': this.machineId,
      'cosy-machinetoken': this.machineToken,
      'login-version': 'v2',
      'user-agent': 'Go-http-client/2.0',
    };
    if (sse) {
      h['cache-control'] = 'no-cache';
      h['cosy-machineos'] = 'x86_64_win32';
      h['cosy-machinehostname'] = this.machineHostname;
    }
    if (modelKey) {
      h['x-model-key'] = modelKey;
      h['x-model-source'] = 'system';
    }
    return h;
  }
}
