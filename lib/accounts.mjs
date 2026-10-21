/**
 * Qoder 账号池。
 *
 * 存储：`~/.dsh/qoder-accounts.json`
 *   { "version": 2, "accounts": [ {
 *       id, label,
 *       realm: "cn" | "intl",
 *       credential: "pt-…" | "dt-…",      // PAT 或 OAuth access token
 *       refreshToken?: "drt-…",           // OAuth 需要
 *       uid?, nickname?                   // 可选，省一次 userinfo
 *       addedAt
 *   } ] }
 *
 * 兼容：
 *   - 旧字段 `pat` 自动读成 `credential`（realm 视为 cn）
 *   - 池为空时回落到 `~/.dsh/qoder.token` 单账号，行为与以前一致
 *
 * PAT 和 OAuth token 都是明文存，和 DSH 自己的 `.credentials.yaml` 一个级别，
 * 靠文件权限保护。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ACCOUNTS_FILE = path.join(os.homedir(), '.dsh', 'qoder-accounts.json');
export const LEGACY_TOKEN_FILE = path.join(os.homedir(), '.dsh', 'qoder.token');

export const REALMS = ['cn', 'intl'];

function emptyPool() {
  return { version: 2, accounts: [] };
}

/** 把任意历史形状的条目规整成当前形状；不合法返回 null。 */
function normalize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const credential = String(entry.credential ?? entry.pat ?? '').trim();
  if (credential.length === 0) return null;
  const realm = REALMS.includes(entry.realm) ? entry.realm : 'cn';
  return {
    id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : accountIdFor(credential),
    label: typeof entry.label === 'string' ? entry.label : '',
    realm,
    credential,
    // 停用的账号留在池里但不参与轮询：账号还能用但暂时不该被选中时
    // （排队、额度耗尽、正在风控），禁用比删除安全——凭证不会丢。
    enabled: entry.enabled !== false,
    ...(typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0
      ? { refreshToken: entry.refreshToken }
      : {}),
    ...(typeof entry.uid === 'string' && entry.uid.length > 0 ? { uid: entry.uid } : {}),
    ...(typeof entry.nickname === 'string' ? { nickname: entry.nickname } : {}),
    ...(typeof entry.expiresAt === 'string' && entry.expiresAt.length > 0 ? { expiresAt: entry.expiresAt } : {}),
    addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
  };
}

/** 启用/停用一个账号（停用后它留在池里，但不参与轮询）。 */
export function setEnabled(idOrLabel, enabled) {
  const pool = loadPool();
  const account = pool.accounts.find((a) => a.id === idOrLabel || a.label === idOrLabel);
  if (!account) return null;
  account.enabled = enabled !== false;
  savePool(pool);
  return account;
}

export function loadPool() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.accounts)) return emptyPool();
    return {
      version: 2,
      // 区域偏好：默认国际版优先；"cn" 可切回国内优先；"none" 保持文件顺序
      preferRealm: REALMS.includes(parsed.preferRealm) || parsed.preferRealm === 'none' ? parsed.preferRealm : 'intl',
      accounts: parsed.accounts.map(normalize).filter(Boolean),
    };
  } catch {
    return emptyPool();
  }
}

function savePool(pool) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = `${ACCOUNTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

/** 设区域偏好：intl / cn / none（none = 保持文件顺序）。 */
export function setPreferRealm(realm) {
  if (realm !== 'none' && !REALMS.includes(realm)) throw new Error(`realm 只能是 ${REALMS.join(' / ')} / none`);
  const pool = loadPool();
  pool.preferRealm = realm;
  savePool(pool);
  return realm;
}

/**
 * 按区域偏好排序（稳定排序，同一区域内保持原顺序）。
 *
 * 这只影响**轮询起点**：优先区的账号排在前面先被选中，
 * 它们全失败时才轮到另一个区。
 */
export function orderByPreference(accounts, preferRealm = 'intl') {
  if (!preferRealm || preferRealm === 'none') return accounts;
  const preferred = [];
  const rest = [];
  for (const a of accounts) (a.realm === preferRealm ? preferred : rest).push(a);
  return [...preferred, ...rest];
}

/** 凭证的短指纹，做账号 id（同一凭证永远同一个 id，天然幂等）。 */
export function accountIdFor(credential) {
  return `acct-${crypto.createHash('sha256').update(credential, 'utf8').digest('hex').slice(0, 8)}`;
}

/**
 * 加一个账号。同一凭证重复添加时只更新昵称/realm/refreshToken。
 * 凭证前缀决定认证方式：pt- 走 PAT，dt- 走 OAuth。
 */
export function addAccount({ credential, label = '', realm = 'cn', refreshToken = '', uid = '', nickname = '', expiresAt = '' }) {
  const value = String(credential ?? '').trim();
  if (!/^(pt|dt)-/.test(value)) throw new Error('凭证必须以 pt-（PAT）或 dt-（OAuth）开头');
  if (!REALMS.includes(realm)) throw new Error(`realm 只能是 ${REALMS.join(' / ')}`);

  const pool = loadPool();
  const id = accountIdFor(value);
  // 去重优先认「同一用户 + 同一区域」：OAuth 凭证每次刷新都会轮换，
  // 只按凭证指纹去重的话，刷新后再导入一次就会多出一条重复账号。
  const existing =
    (uid ? pool.accounts.find((a) => a.uid === uid && a.realm === realm) : undefined) ??
    pool.accounts.find((a) => a.id === id);
  const patch = {
    // credential 必须一起更新：OAuth 每次刷新都换发新 dt-，
    // 漏掉这一项会让「导入新凭证」变成空操作 —— 池里永远留着旧的，
    // 表现就是导入显示成功、推理仍然 403 Login expired。
    credential: value,
    ...(label ? { label } : {}),
    realm,
    ...(refreshToken ? { refreshToken } : {}),
    ...(uid ? { uid } : {}),
    ...(nickname ? { nickname } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };

  if (existing) {
    Object.assign(existing, patch);
    savePool(pool);
    return { account: existing, created: false };
  }

  const account = {
    id,
    label: label || `账号 ${pool.accounts.length + 1}`,
    realm,
    credential: value,
    ...(refreshToken ? { refreshToken } : {}),
    ...(uid ? { uid } : {}),
    ...(nickname ? { nickname } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    addedAt: new Date().toISOString(),
  };
  pool.accounts.push(account);
  savePool(pool);
  return { account, created: true };
}

export function removeAccount(idOrLabel) {
  const pool = loadPool();
  const before = pool.accounts.length;
  pool.accounts = pool.accounts.filter((a) => a.id !== idOrLabel && a.label !== idOrLabel);
  savePool(pool);
  return before - pool.accounts.length;
}

/**
 * 回写刷新后的凭证。
 *
 * 刷新是「凭证轮换」而不是「凭证不变」：OAuth 每次 refresh 都会换新的
 * refresh_token，旧的随即失效。不回写的话进程重启就用旧凭证，直接登录过期。
 *
 * 认 id 而不是认凭证前缀——刷新前后 credential 本身会变。
 */
export function updateCredential(id, { credential, refreshToken, expiresAt }) {
  const pool = loadPool();
  const account = pool.accounts.find((a) => a.id === id);
  if (!account) return null;
  if (typeof credential === 'string' && credential.length > 0) account.credential = credential;
  if (typeof refreshToken === 'string' && refreshToken.length > 0) account.refreshToken = refreshToken;
  if (typeof expiresAt === 'string' && expiresAt.length > 0) account.expiresAt = expiresAt;
  savePool(pool);
  return account;
}

/**
 * 当前可用账号，已按区域偏好排序（默认国际版在前）。
 *
 * 池为空时回落成单账号（读 legacy token 文件），形状一致。
 * 传 `ordered: false` 可以拿到原始文件顺序（CLI 列表用）。
 */
export function listAccounts(legacyToken = '', { ordered = true, includeDisabled = false } = {}) {
  const pool = loadPool();
  if (pool.accounts.length > 0) {
    // 停用的账号默认不参与轮询；CLI 列表要显示它们，所以留 includeDisabled
    const usable = includeDisabled ? pool.accounts : pool.accounts.filter((a) => a.enabled !== false);
    return ordered ? orderByPreference(usable, pool.preferRealm) : usable;
  }
  const token = String(legacyToken ?? '').trim();
  if (token.length === 0) return [];
  return [
    {
      id: accountIdFor(token),
      label: '(qoder.token)',
      realm: 'cn',
      credential: token,
      addedAt: null,
    },
  ];
}

/** 脱敏展示：只露前 8 位和后 4 位。 */
export function maskPat(value) {
  const s = String(value);
  return s.length <= 14 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}
