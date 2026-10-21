#!/usr/bin/env node
/**
 * Qoder 账号池 CLI。
 *
 *   node lib/cli.mjs import-desktop [--realm cn|intl]   从桌面客户端导入已登录凭证
 *   node lib/cli.mjs add <pt-…|dt-…> [昵称] [--realm intl] [--refresh drt-…]
 *   node lib/cli.mjs add --stdin [昵称] [--realm intl]  从标准输入读凭证
 *   node lib/cli.mjs list / test [id|昵称] / remove <id|昵称> / use <id|昵称>
 *
 * 凭证前缀决定认证方式：pt- 是 PAT（换 jobToken），dt- 是 OAuth（直通，国际版走这条）。
 * 池为空时插件自动回落读 ~/.dsh/qoder.token。
 */
import fs from 'node:fs';
import path from 'node:path';
import { addAccount, listAccounts, removeAccount, maskPat, loadPool, setPreferRealm, ACCOUNTS_FILE, LEGACY_TOKEN_FILE, REALMS } from './accounts.mjs';
import { ensureIdentity, invalidateIdentity, realmConfig } from './qoder-client.mjs';
import { readAllDesktopAuth, readDesktopAuth, DESKTOP_DIRS } from './desktop-auth.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function option(name, fallback = '') {
  const i = rest.indexOf(name);
  return i >= 0 ? (rest[i + 1] ?? fallback) : fallback;
}
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) { i += 1; continue; }
    out.push(rest[i]);
  }
  return out;
}

function readLegacyToken() {
  try {
    return fs.readFileSync(LEGACY_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

async function identify(account) {
  invalidateIdentity(account.credential, account.realm);
  return ensureIdentity(account.credential, {
    force: true,
    realm: account.realm,
    refreshToken: account.refreshToken,
    uid: account.uid,
    nickname: account.nickname,
  });
}

function printTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

async function main() {
  switch (cmd) {
    case 'import-desktop': {
      const want = option('--realm');
      const found = want ? [readDesktopAuth(want)].filter(Boolean) : readAllDesktopAuth();
      if (found.length === 0) {
        console.log(`没找到已登录的桌面客户端凭证。\n  CN  : %APPDATA%\\${DESKTOP_DIRS.cn}\\auth.v1.dat\n  INTL: %APPDATA%\\${DESKTOP_DIRS.intl}\\auth.v1.dat`);
        return;
      }
      for (const hit of found) {
        // 桌面端和我们自己都会刷新，两边各有一份 token。
        // 只接受不早于池里那份的，避免用旧凭证覆盖掉刚续出来的。
        const existing = listAccounts().find(
          (a) => (hit.user?.id && a.uid === hit.user.id && a.realm === hit.realm) || a.id === hit.realm,
        );
        if (existing?.expiresAt && hit.expiresAt && Date.parse(hit.expiresAt) < Date.parse(existing.expiresAt)) {
          console.log(`跳过 ${existing.id} [${existing.realm}]：池里的凭证更新（${existing.expiresAt} > ${hit.expiresAt}）`);
          continue;
        }

        const label = `${hit.realm === 'intl' ? '国际版' : '国内版'} · ${hit.user?.name ?? hit.user?.email ?? '账号'}`;
        const { account, created } = addAccount({
          credential: hit.token,
          label,
          realm: hit.realm,
          refreshToken: hit.refreshToken,
          uid: hit.user?.id ?? '',
          nickname: hit.user?.name ?? '',
          expiresAt: hit.expiresAt ?? '',
        });
        console.log(`${created ? '已导入' : '已更新'}: ${account.id}  [${account.realm}] ${account.label}  ${maskPat(account.credential)}`);
        if (hit.expiresAt) console.log(`  access token 到期: ${hit.expiresAt}`);
      }
      break;
    }

    case 'add': {
      const fromStdin = rest[0] === '--stdin';
      const pos = positional();
      const credential = fromStdin ? fs.readFileSync(0, 'utf8').trim() : (pos[0] ?? '');
      const label = fromStdin ? (pos.find((p, i) => i >= 0 && p !== 'add') ?? '') : (pos[1] ?? '');
      const realm = option('--realm', 'cn');
      const refreshToken = option('--refresh', '');
      if (!credential) {
        console.error('用法: node lib/cli.mjs add <pt-…|dt-…> [昵称] [--realm intl] [--refresh drt-…]');
        process.exit(1);
      }
      const { account, created } = addAccount({ credential, label, realm, refreshToken });
      console.log(`${created ? '已添加' : '已存在，已更新'}: ${account.id}  [${account.realm}] ${account.label}  ${maskPat(account.credential)}`);
      try {
        const id = await identify(account);
        console.log(`验证通过: uid=${id.uid}  name=${id.nickname || '(无)'}  user_type=${id.userType}`);
      } catch (e) {
        console.log(`验证失败（账号已保存）: ${e.message.slice(0, 160)}`);
      }
      break;
    }

    case 'list': {
      const pool = listAccounts(readLegacyToken());
      if (pool.length === 0) {
        console.log(`账号池为空。\n  池文件: ${ACCOUNTS_FILE}\n  回落文件: ${LEGACY_TOKEN_FILE}（也不存在）`);
        break;
      }
      const rows = pool.map((a, i) => [
        i + 1,
        a.id,
        a.realm,
        a.label,
        maskPat(a.credential),
        a.credential.startsWith('dt-') ? 'oauth' : 'pat',
      ]);
      printTable(rows, ['#', 'id', '区', '昵称', '凭证', '类型']);
      if (!fs.existsSync(ACCOUNTS_FILE)) console.log(`\n（单账号回落模式，来自 ${LEGACY_TOKEN_FILE}）`);
      break;
    }

    case 'remove': {
      const key = positional()[0];
      if (!key) { console.error('用法: node lib/cli.mjs remove <id|昵称>'); process.exit(1); }
      const n = removeAccount(key);
      console.log(n > 0 ? `已删除 ${n} 个账号` : '没找到匹配的账号');
      break;
    }

    case 'test': {
      const pool = listAccounts(readLegacyToken());
      if (pool.length === 0) { console.error('账号池为空'); process.exit(1); }
      const key = positional()[0];
      const targets = key ? pool.filter((a) => a.id === key || a.label === key) : pool;
      if (targets.length === 0) { console.error(`没找到账号: ${key}`); process.exit(1); }
      for (const a of targets) {
        try {
          const id = await identify(a);
          console.log(`✓ ${a.id} [${a.realm}] ${a.label}  uid=${id.uid}  name=${id.nickname || '(无)'}  gateway=${realmConfig(a.realm).gateway}`);
        } catch (e) {
          console.log(`✗ ${a.id} [${a.realm}] ${a.label}  ${e.message.slice(0, 160)}`);
        }
      }
      break;
    }

    case 'use': {
      const key = positional()[0];
      if (!key) { console.error('用法: node lib/cli.mjs use <id|昵称>'); process.exit(1); }
      const found = listAccounts(readLegacyToken()).find((a) => a.id === key || a.label === key);
      if (!found) { console.error(`没找到账号: ${key}`); process.exit(1); }
      fs.mkdirSync(path.dirname(LEGACY_TOKEN_FILE), { recursive: true });
      fs.writeFileSync(LEGACY_TOKEN_FILE, found.credential, 'utf8');
      console.log(`已把 ${found.id}（${found.label}）写入 ${LEGACY_TOKEN_FILE}`);
      console.log('注意：账号池存在时以池为准，这个文件只在池为空时被读取。');
      break;
    }

    case 'prefer': {
      const realm = positional()[0];
      if (!realm) {
        console.log(`当前偏好: ${loadPool().preferRealm ?? 'intl'}`);
        console.log('用法: node lib/cli.mjs prefer intl|cn|none');
        break;
      }
      const applied = setPreferRealm(realm);
      console.log(
        `已设置区域偏好: ${applied}${applied === 'none' ? '（按文件顺序）' : '（该区账号优先被选中，全挂才轮到另一个区）'}`,
      );
      break;
    }

    default:
      console.log(`Qoder 账号池（国内版 / 国际版）

  node lib/cli.mjs import-desktop [--realm cn|intl]   从桌面客户端导入已登录凭证
  node lib/cli.mjs add <pt-…|dt-…> [昵称] [--realm intl] [--refresh drt-…]
  node lib/cli.mjs add --stdin [昵称] [--realm intl]  从标准输入读凭证
  node lib/cli.mjs list                               列出账号
  node lib/cli.mjs test [id|昵称]                     验证账号（省略则全部）
  node lib/cli.mjs remove <id|昵称>                   删除账号
  node lib/cli.mjs use <id|昵称>                      写成默认单账号

  区域: ${REALMS.join(' / ')}
  池文件: ${ACCOUNTS_FILE}
  回落 : ${LEGACY_TOKEN_FILE}
`);
  }
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
