/* Shared helpers: chain/wallet plumbing, API access, formatting, reason-code decoding. */

const CFG = window.DVN_CONFIG
const CHAINS = CFG.chains

/**
 * Reason bit -> code. MUST mirror worker/assess/verdict.ts REASON_BITS, which is append-only —
 * so this table only ever grows, and an unknown bit renders as `bit:N` rather than vanishing.
 */
const REASON_BITS = {
  0: 'sanctions',
  1: 'sanctioned_mixer',
  2: 'scam_token',
  3: 'operator_deny',
  4: 'sanctions_1hop',
  5: 'sanctions_1hop_inbound',
  6: 'mixer_exposure',
  7: 'fake_stablecoin_suspect',
  8: 'honeypot_suspect',
  9: 'contract_admin_risk',
  10: 'unverified_contract',
  11: 'upgradeable_proxy',
  12: 'contract_check_unavailable',
  13: 'token_check_unavailable',
  14: 'owner_approved',
  15: 'sanctions_2hop',
  16: 'sanctions_3hop',
  17: 'sanctions_2hop_inbound',
  18: 'sanctions_3hop_inbound',
  19: 'mixer_exposure_2hop',
  20: 'mixer_exposure_3hop',
  255: 'unmapped',
}

const ACTIONS = ['allow', 'delay', 'manual-review', 'block']

const TOKENS = CFG.tokens

/** Address of a configured token on one chain. */
const tokenAt = (tokenKey, chainKey) => TOKENS[tokenKey].addresses[chainKey]

/**
 * Korean readings for the on-chain vocabulary.
 *
 * Display only — the identifier stays on the element's `title`, because it is what appears in the
 * event log, the policy source, and the CLI. An auditor comparing this screen against a
 * transaction needs the original string within reach.
 */
const LABEL_KO = {
  sanctions: '제재 대상',
  sanctioned_mixer: '제재 믹서',
  scam_token: '스캠 토큰',
  operator_deny: '운영자 차단',
  sanctions_1hop: '제재 1홉',
  sanctions_2hop: '제재 2홉',
  sanctions_3hop: '제재 3홉',
  sanctions_1hop_inbound: '제재 유입 1홉',
  sanctions_2hop_inbound: '제재 유입 2홉',
  sanctions_3hop_inbound: '제재 유입 3홉',
  mixer_exposure: '믹서 노출',
  mixer_exposure_2hop: '믹서 노출 2홉',
  mixer_exposure_3hop: '믹서 노출 3홉',
  fake_stablecoin_suspect: '가짜 스테이블코인 의심',
  honeypot_suspect: '허니팟 의심',
  contract_admin_risk: '컨트랙트 관리자 위험',
  unverified_contract: '미검증 컨트랙트',
  upgradeable_proxy: '업그레이드 가능 프록시',
  contract_check_unavailable: '컨트랙트 조회 실패',
  token_check_unavailable: '토큰 조회 실패',
  owner_approved: 'owner 승인',
  unmapped: '미매핑 사유',
}

const ACTION_KO = { allow: '통과', delay: '지연', 'manual-review': '수동 검토', block: '차단' }

const labelKo = (code) => LABEL_KO[code] ?? code

/** Decode a uint256 reason mask (decimal string) back to labels. */
function decodeReasons(mask) {
  let m
  try {
    m = BigInt(String(mask ?? '0'))
  } catch {
    return []
  }
  const out = []
  for (let bit = 0n; bit <= 255n; bit++) {
    if ((m >> bit) & 1n) out.push(REASON_BITS[Number(bit)] ?? `bit:${bit}`)
  }
  return out
}

const short = (a) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a ?? '')
const labelOf = (a) => (a ? CFG.labels[a.toLowerCase()] : undefined)

/**
 * Address chip: the friendly name when we know it, always with the full value on hover.
 *
 * Only the hex form gets the monospace face. A name rendered in it turned "owner (O)" into what
 * looked like "owner (0)" — in a monospace stack the capital O and the digit sit at the same width
 * with nearly the same shape. Fixed advance is for comparing hex, not for reading words.
 */
function addrChip(a, { link, chain } = {}) {
  if (!a) return '—'
  const name = labelOf(a)
  const inner = name
    ? `<span title="${a}">${name}</span>`
    : `<span class="mono" title="${a}">${short(a)}</span>`
  const base = chain && CHAINS[chain] ? `${CHAINS[chain].explorer}/address/${a}` : undefined
  const href = link === false ? undefined : base
  return href ? `<a href="${href}" target="_blank" rel="noopener">${inner}</a>` : inner
}

/**
 * Copy button for a value the row only shows abbreviated.
 *
 * The click is handled by one delegated listener rather than a handler per button: these render
 * inside tables that are replaced wholesale on every refresh, and per-row handlers would be rebound
 * hundreds of times a minute.
 */
function copyBtn(value, label = '주소 복사') {
  return `<button class="copy" type="button" data-copy="${value}" title="${label}" aria-label="${label}"></button>`
}

/** Selection-based copy, for when the async clipboard is unavailable or refuses. */
function copyViaSelection(value) {
  const ta = document.createElement('textarea')
  ta.value = value
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('[data-copy]')
  if (!btn) return
  const value = btn.dataset.copy

  // The async clipboard rejects when the document is not focused, so a refusal is a reason to fall
  // back rather than to give up — treating "API exists" as "API will work" loses the copy silently.
  let ok = false
  try {
    await navigator.clipboard.writeText(value)
    ok = true
  } catch {
    try {
      ok = copyViaSelection(value)
    } catch {
      ok = false
    }
  }

  btn.classList.add(ok ? 'copied' : 'failed')
  btn.title = ok ? '복사됨' : '복사 실패 — 주소를 직접 선택해 복사하세요'
  setTimeout(() => {
    btn.classList.remove('copied', 'failed')
    btn.title = '주소 복사'
  }, 1400)
})

function txLink(chain, hash) {
  const c = CHAINS[chain]
  if (!c || !hash) return short(hash)
  return `<a class="mono" href="${c.explorer}/tx/${hash}" target="_blank" rel="noopener" title="${hash}">${short(hash)}</a>`
}

const LZ_SCAN = 'https://testnet.layerzeroscan.com'

/**
 * Link into LayerZero Scan by SOURCE transaction.
 *
 * It has to be the source tx: that is the one carrying the message, so Scan can show the packet's
 * lifecycle — including a blocked packet sitting unverified forever, which is the whole point of
 * looking. The verdict transaction is a call to our own DVN and is not part of any message, so
 * Scan would have nothing to show for it.
 */
function lzLink(srcTxHash, text = 'LayerZero Scan') {
  if (!srcTxHash) return '<span class="muted">—</span>'
  return `<a href="${LZ_SCAN}/tx/${srcTxHash}" target="_blank" rel="noopener" title="${srcTxHash}">${text}</a>`
}

/** Sends remembered by this browser. Shared so any page can resolve a payload back to its source tx. */
const SENT_KEY = 'dvn-demo-sent'
const loadSent = () => {
  try {
    return JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]')
  } catch {
    return []
  }
}
const saveSent = (list) => localStorage.setItem(SENT_KEY, JSON.stringify(list.slice(0, 40)))

/**
 * payloadHash -> the send that produced it.
 *
 * The indexer records a verdict's own transaction, not the send it judged, so the link back to the
 * source tx is only knowable here — from what this browser sent. Rows it does not recognise simply
 * show no LayerZero link rather than a guess.
 */
function sentByPayload() {
  const map = new Map()
  for (const s of loadSent()) if (s.payloadHash) map.set(s.payloadHash.toLowerCase(), s)
  return map
}

/**
 * `${srcKey}>${dstKey}/${tokenKey}:${nonce}` -> the send that occupied that channel slot.
 *
 * Keyed by token as well as pathway: each token is its own channel with its own nonce sequence, so
 * nonce 2 exists once per token and the two must not be confused for each other.
 *
 * Nothing on-chain ties a nonce to a business meaning — the channel only knows the ordering. So a
 * stalled nonce can only be named from what this browser sent; anything else is honestly unknown.
 */
function sentByNonce() {
  const map = new Map()
  for (const s of loadSent()) {
    if (s.nonce !== undefined) map.set(`${s.srcKey}>${s.dstKey}/${s.tokenKey ?? 'testUSDT'}:${s.nonce}`, s)
  }
  return map
}

function fmtTime(unixSeconds) {
  if (!unixSeconds) return '—'
  return new Date(Number(unixSeconds) * 1000).toLocaleString()
}

function fmtAgo(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  return `${Math.floor(s / 3600)}시간 전`
}

/** 18-decimal amount -> trimmed decimal string, without pulling in a bignum library. */
function fmtUnits(raw, decimals = 18) {
  const s = String(raw ?? '0').padStart(decimals + 1, '0')
  const whole = s.slice(0, -decimals).replace(/^0+(?=\d)/, '')
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole
}

function actionBadge(action) {
  const name = typeof action === 'number' ? ACTIONS[action] ?? `action:${action}` : action
  const cls = { allow: 'ok', delay: 'warn', 'manual-review': 'hold', block: 'bad' }[name] ?? 'muted'
  return `<span class="badge ${cls}" title="${name}">${ACTION_KO[name] ?? name}</span>`
}

/** Labels that assert the subject IS the thing, rather than that it is near one — shown in red. */
const DIRECT_HIT = new Set(['sanctions', 'sanctioned_mixer', 'scam_token', 'operator_deny'])

function reasonChips(codes) {
  if (!codes || !codes.length) return '<span class="muted">—</span>'
  return codes
    .map((c) => `<span class="chip ${DIRECT_HIT.has(c) ? 'chip-risk' : ''}" title="${c}">${labelKo(c)}</span>`)
    .join(' ')
}

/**
 * A `?` marker that reveals an explanation card on hover.
 *
 * The design rationale behind a panel matters when someone asks "why can't the worker just release
 * this?", and not at all the rest of the time. Kept out of the layout until asked for, so the
 * panel itself stays a list of facts.
 */
function helpMark(html) {
  return `<span class="help" tabindex="0" aria-label="설명"><span class="help-card">${html}</span></span>`
}

/* ── API ─────────────────────────────────────────────────────────────────── */

async function api(base, path) {
  const res = await fetch(`${base}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

const indexerApi = (path) => api(CFG.indexerApi, path)
const workerApi = (path) => api(CFG.workerApi, path)

/* ── wallet ──────────────────────────────────────────────────────────────── */

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

const OFT_ABI = [
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee))',
  'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee), (uint256 amountSentLD, uint256 amountReceivedLD))',
]

const DVN_ABI = ['function approvePacket(bytes32 payloadHash)', 'function owner() view returns (address)']

/**
 * Endpoint reads for the message channel, plus `skip`.
 *
 * A vetoed packet is never verified, so its nonce never gets a payload hash — and the channel
 * clears nonces strictly in order. Every later message on that pathway is therefore stuck behind
 * it, permanently. `skip` is LayerZero's way out: the OApp or its delegate advances past a nonce
 * that will never arrive. It is an administrative decision about a specific message, which is why
 * it belongs to the owner rather than to the worker.
 */
const ENDPOINT_ABI = [
  'function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)',
  'function outboundNonce(address sender, uint32 dstEid, bytes32 receiver) view returns (uint64)',
  'function skip(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce)',
]

const HASH_ZERO = '0x' + '0'.repeat(64)

/**
 * State of one direction's channel: how far it has executed, and whether it is stalled.
 *
 * "Stalled" means the source has sent a message at the next nonce but that nonce holds no payload
 * hash — the packet the DVN refused. Without comparing against the source's outbound nonce a gap
 * would be indistinguishable from a packet that simply has not been committed yet.
 */
async function channelState(srcKey, dstKey, tokenKey = 'testUSDT') {
  const src = CHAINS[srcKey]
  const dst = CHAINS[dstKey]
  // A channel is keyed by (receiver OApp, srcEid, sender OApp), so each token has its own.
  const srcOApp = tokenAt(tokenKey, srcKey)
  const dstOApp = tokenAt(tokenKey, dstKey)
  const senderB32 = ethers.utils.hexZeroPad(srcOApp, 32)
  const receiverB32 = ethers.utils.hexZeroPad(dstOApp, 32)

  const dstEp = new ethers.Contract(dst.endpoint, ENDPOINT_ABI, readProvider(dstKey))
  const srcEp = new ethers.Contract(src.endpoint, ENDPOINT_ABI, readProvider(srcKey))

  const [executed, verified, sent] = await Promise.all([
    dstEp.lazyInboundNonce(dstOApp, src.eid, senderB32),
    dstEp.inboundNonce(dstOApp, src.eid, senderB32),
    srcEp.outboundNonce(srcOApp, dst.eid, receiverB32),
  ])

  const next = verified.add(1)
  const nextHash = next.lte(sent) ? await dstEp.inboundPayloadHash(dstOApp, src.eid, senderB32, next) : HASH_ZERO
  const stalled = next.lte(sent) && nextHash === HASH_ZERO

  // Per-nonce detail for everything not yet executed, so a stall can be explained rather than just
  // reported. Capped: each entry costs one call, and only the unexecuted tail is interesting.
  const from = Math.max(1, executed.toNumber() + 1)
  const to = sent.toNumber()
  const first = Math.max(from, to - 11)
  const slots = []
  for (let n = first; n <= to; n++) {
    const hash = await dstEp.inboundPayloadHash(dstOApp, src.eid, senderB32, n)
    slots.push({
      nonce: n,
      committed: hash !== HASH_ZERO,
      // The gap that holds the line is the first uncommitted nonce; later gaps are behind it.
      blocking: hash === HASH_ZERO && n === next.toNumber(),
    })
  }

  return {
    srcKey,
    dstKey,
    tokenKey,
    executed: executed.toNumber(),
    verified: verified.toNumber(),
    sent: sent.toNumber(),
    stalledAt: stalled ? next.toNumber() : undefined,
    pending: Math.max(0, sent.toNumber() - executed.toNumber()),
    truncated: from < first,
    slots,
  }
}

/**
 * Decode the LayerZero V2 81-byte packet header.
 *
 * A held packet persists its header, and the header already names everything a rejection needs —
 * which channel, which slot. Reading it beats looking the pathway up in config: it is the packet's
 * own account of itself, and it stays right for a token the dashboard has never heard of.
 */
function decodePacketHeader(headerHex) {
  const h = headerHex.startsWith('0x') ? headerHex.slice(2) : headerHex
  if (h.length !== 81 * 2) throw new Error(`패킷 헤더는 81바이트여야 합니다 (받은 값: ${h.length / 2}바이트)`)
  const at = (startByte, lenBytes) => h.slice(startByte * 2, (startByte + lenBytes) * 2)
  return {
    nonce: Number(BigInt('0x' + at(1, 8))),
    srcEid: parseInt(at(9, 4), 16),
    sender: '0x' + at(13, 32),
    dstEid: parseInt(at(45, 4), 16),
    receiver: '0x' + at(49 + 12, 20),
  }
}

/**
 * Is this packet's nonce the one the channel will clear next?
 *
 * `skip` only works at the head of the queue (`nonce == inboundNonce + 1`) — LayerZero clears
 * nonces strictly in order, so a later slot cannot be abandoned before an earlier one. Reading the
 * answer lets the page say which packet has to go first instead of surfacing `LZ_InvalidNonce`.
 */
async function skipEligibility(dstKey, header) {
  const h = decodePacketHeader(header)
  const ep = new ethers.Contract(CHAINS[dstKey].endpoint, ENDPOINT_ABI, readProvider(dstKey))
  const next = (await ep.inboundNonce(h.receiver, h.srcEid, h.sender)).add(1).toNumber()
  return { ok: next === h.nonce, next, nonce: h.nonce }
}

/**
 * Reject a packet: skip its nonce so the endpoint can never execute it.
 *
 * This is the owner's refusal, and it is the endpoint that enforces it — not the DVN and not the
 * worker, which holds only the operator key. The worker notices the skip on its next pass and drops
 * the packet from its hold queue.
 */
async function skipPacket(dstKey, header) {
  const h = decodePacketHeader(header)
  await ensureChain(dstKey)
  const ep = new ethers.Contract(CHAINS[dstKey].endpoint, ENDPOINT_ABI, signer())
  const tx = await ep.skip(h.receiver, h.srcEid, h.sender, h.nonce)
  await tx.wait()
  return tx.hash
}

/** Skip one nonce that will never be verified. Signed by the owner (the OApp's delegate). */
async function skipNonce(srcKey, dstKey, nonce, tokenKey = 'testUSDT') {
  const src = CHAINS[srcKey]
  const dst = CHAINS[dstKey]
  await ensureChain(dstKey)
  const ep = new ethers.Contract(dst.endpoint, ENDPOINT_ABI, signer())
  const tx = await ep.skip(tokenAt(tokenKey, dstKey), src.eid, ethers.utils.hexZeroPad(tokenAt(tokenKey, srcKey), 32), nonce)
  await tx.wait()
  return tx.hash
}

let _signer
/** The injected provider actually in use — not necessarily `window.ethereum`. See pickWallet. */
let _injected
let _walletName = ''

/**
 * Wallets that announced themselves under EIP-6963, keyed by rdns.
 *
 * The listener is registered before the request is dispatched because wallets answer the request
 * event synchronously; a listener added afterwards would miss every announcement.
 */
const _announced = new Map()
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = e.detail
  if (d && d.info && d.provider) _announced.set(d.info.rdns || d.info.name, d)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

/**
 * Every injected EVM provider we can see, best candidate first.
 *
 * `window.ethereum` alone is not enough. A multi-chain wallet claims it too, and one holding no
 * Ethereum account rejects `eth_requestAccounts` with "Unable to find any account for 60" — 60
 * being Ethereum's BIP-44 coin type. EIP-6963 lets us enumerate what is really installed; the
 * legacy `providers` array covers wallets that predate it.
 */
/** Name a pre-EIP-6963 provider from its own flag, so an error can say which wallet refused. */
function legacyWalletName(p) {
  if (p.isMetaMask) return 'MetaMask'
  if (p.isPhantom) return 'Phantom'
  if (p.isRabby) return 'Rabby'
  if (p.isCoinbaseWallet) return 'Coinbase Wallet'
  if (p.isBraveWallet) return 'Brave Wallet'
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet'
  if (p.isOkxWallet || p.isOKExWallet) return 'OKX Wallet'
  return '주입된 지갑'
}

function injectedWallets() {
  const found = []
  for (const { info, provider } of _announced.values()) found.push({ name: info.name, rdns: info.rdns, provider })

  const eth = window.ethereum
  if (eth) {
    const legacy = Array.isArray(eth.providers) ? eth.providers : [eth]
    for (const p of legacy) {
      if (found.some((f) => f.provider === p)) continue
      found.push({ name: legacyWalletName(p), rdns: '', provider: p })
    }
  }

  // MetaMask first: it is what the demo is set up against, and it always has an EVM account.
  const rank = (w) => (/metamask/i.test(w.rdns + w.name) ? 0 : /rabby|coinbase|rainbow|trust/i.test(w.rdns + w.name) ? 1 : 2)
  return found.sort((a, b) => rank(a) - rank(b))
}

function hasWallet() {
  return injectedWallets().length > 0
}

/**
 * Custom-error selectors worth naming, since none of them carry a revert string.
 *
 * A wallet reports these as "Internal JSON-RPC error", which says nothing about what to change.
 * The selector is the only part of the payload that identifies the cause, so it is decoded here.
 */
const REVERT_SELECTORS = {
  '0x6592671c': { text: 'lzReceive 실행자 옵션이 유효하지 않습니다 (extraOptions 누락 또는 형식 오류)' },
  '0xf6ff4fb7': { text: '목적지 체인의 peer가 설정되지 않았습니다 — lz:oapp:wire 를 다시 실행하세요' },
  // Not a shortfall: OAppSender._payNative demands msg.value EXACTLY equal to the quoted fee, so
  // paying over reverts here too. The argument is the msg.value that was rejected.
  '0x9f704120': {
    text: 'msg.value가 견적 수수료와 정확히 일치하지 않습니다 (초과 지불도 거부됩니다)',
    args: ['uint256'],
    render: ([v]) => `보낸 값 ${fmtUnits(v.toString())} ETH`,
  },
  '0x71c4efed': { text: '수령 수량이 minAmountLD 아래로 떨어졌습니다' },
  '0xe450d38c': {
    text: 'testUSDT 잔액이 부족합니다',
    args: ['address', 'uint256', 'uint256'],
    render: ([, bal, need]) => `보유 ${fmtUnits(bal.toString())} / 필요 ${fmtUnits(need.toString())}`,
  },
  '0x96c6fd1e': { text: '보낸 주소가 유효하지 않습니다' },
  '0x6c1ccdb5': { text: '이 경로의 기본 SendLibrary가 설정되지 않았습니다' },
  '0xf0c10d04': { text: '지원되지 않는 목적지 EID입니다' },
  '0xb5863604': { text: 'OApp delegate 설정이 잘못되었습니다' },
  '0x91ac5e4f': { text: 'Endpoint만 호출할 수 있는 함수입니다' },
  '0xcf479181': { text: '네이티브 잔액이 부족합니다' },
}

/**
 * Dig the real cause out of a wallet error.
 *
 * MetaMask wraps a node's response and surfaces only "Internal JSON-RPC error" (-32603); the revert
 * payload sits several levels down under a different key depending on the wallet and the ethers
 * version. Every place it is known to hide is checked, and the four-byte selector is translated.
 */
function decodeRpcError(err) {
  const seen = new Set()
  const hexes = []
  const walk = (o, depth) => {
    if (!o || depth > 6 || typeof o !== 'object' || seen.has(o)) return
    seen.add(o)
    for (const v of Object.values(o)) {
      if (typeof v === 'string') {
        const m = v.match(/0x[0-9a-fA-F]{8,}/)
        if (m) hexes.push(m[0])
      } else if (typeof v === 'object') {
        walk(v, depth + 1)
      }
    }
  }
  walk(err, 0)

  for (const hex of hexes) {
    const selector = hex.slice(0, 10).toLowerCase()
    const known = REVERT_SELECTORS[selector]
    if (!known) continue
    let detail = ''
    if (known.args) {
      // The arguments are where the useful numbers are — what was sent versus what was required.
      try {
        const decoded = ethers.utils.defaultAbiCoder.decode(known.args, '0x' + hex.slice(10))
        detail = ` — ${known.render(decoded)}`
      } catch {
        // A truncated payload still identifies the cause; the numbers are a bonus.
      }
    }
    return `${known.text}${detail} (${selector})`
  }
  const msg = err?.error?.message ?? err?.data?.message ?? err?.reason ?? err?.message ?? String(err)
  if (/insufficient funds/i.test(msg)) return '가스비로 쓸 네이티브 잔액이 부족합니다'
  return msg
}

/** Turn a wallet's own rejection into something an operator can act on. */
function walletError(err, name) {
  const msg = String(err && err.message ? err.message : err)
  if (/account for 60|no.*(evm|ethereum).*account/i.test(msg)) {
    return new Error(
      `${name}에 이더리움 계정이 없습니다 (coin type 60). 이 지갑은 EVM 계정 없이 window.ethereum을 ` +
        '차지하고 있습니다 — MetaMask를 설치·활성화하거나, 해당 지갑에서 이더리움 계정을 추가하세요.',
    )
  }
  if (err && err.code === 4001) return new Error('지갑에서 연결을 거부했습니다.')
  return err
}

/**
 * Connect a wallet. Tries each injected provider in turn, so one without an EVM account does not
 * dead-end the page when a usable wallet is also installed.
 */
async function connect() {
  const wallets = injectedWallets()
  if (!wallets.length) throw new Error('지갑 확장 프로그램을 찾을 수 없습니다 — MetaMask를 설치하거나 CLI를 사용하세요.')

  let lastErr
  for (const w of wallets) {
    try {
      const provider = new ethers.providers.Web3Provider(w.provider, 'any')
      await provider.send('eth_requestAccounts', [])
      _injected = w.provider
      _walletName = w.name
      _signer = provider.getSigner()
      return { address: await _signer.getAddress(), provider, wallet: w.name }
    } catch (err) {
      lastErr = walletError(err, w.name)
      // A user-declined prompt is a decision, not a broken wallet: stop rather than prompting again.
      if (err && err.code === 4001) throw lastErr
    }
  }
  throw lastErr
}

function signer() {
  if (!_signer) throw new Error('먼저 지갑을 연결하세요')
  return _signer
}

function walletName() {
  return _walletName
}

/**
 * Follow the wallet after connecting: switching account or network in MetaMask should update the
 * page, not leave it showing a stale address that the next transaction will contradict.
 */
function onWalletChange(handler) {
  if (!_injected || typeof _injected.on !== 'function') return
  _injected.on('accountsChanged', (accounts) => handler({ accounts: accounts ?? [] }))
  _injected.on('chainChanged', () => {
    // The cached provider still holds the old network; rebind before anyone signs with it.
    _signer = new ethers.providers.Web3Provider(_injected, 'any').getSigner()
    handler({ chainChanged: true })
  })
}

/** Chain the wallet is currently on, or undefined if it is not one we know. */
async function currentChainKey() {
  if (!_injected) return undefined
  const id = String(await _injected.request({ method: 'eth_chainId' })).toLowerCase()
  return Object.keys(CHAINS).find((k) => CHAINS[k].chainIdHex.toLowerCase() === id)
}

/** Switch the connected wallet to `chainKey`, adding the network if it is not known yet. */
async function ensureChain(chainKey) {
  if (!_injected) throw new Error('먼저 지갑을 연결하세요')
  const c = CHAINS[chainKey]
  const current = await _injected.request({ method: 'eth_chainId' })
  if (String(current).toLowerCase() === c.chainIdHex.toLowerCase()) return
  try {
    await _injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.chainIdHex }] })
  } catch (err) {
    // 4902 = chain unknown to the wallet; offer to add it rather than dead-ending.
    if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
      await _injected.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: c.chainIdHex,
            chainName: c.label,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [c.rpc],
            blockExplorerUrls: [c.explorer],
          },
        ],
      })
    } else {
      throw walletError(err, _walletName)
    }
  }
  // Re-bind: the provider caches the old network otherwise.
  _signer = new ethers.providers.Web3Provider(_injected, 'any').getSigner()
}

/** Read-only provider per chain, so pages can query without a wallet connected. */
const _readProviders = {}
function readProvider(chainKey) {
  if (!_readProviders[chainKey]) {
    _readProviders[chainKey] = new ethers.providers.JsonRpcProvider(CHAINS[chainKey].rpc)
  }
  return _readProviders[chainKey]
}

/* ── small DOM helpers ───────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

function setStatus(el, text, kind = '') {
  el.className = `status ${kind}`
  el.innerHTML = text
}

/** Render a table from rows + column definitions ([label, renderFn]). */
function table(rows, columns, emptyText = '데이터가 없습니다.') {
  if (!rows.length) return `<p class="muted">${emptyText}</p>`
  const head = columns.map(([label]) => `<th>${label}</th>`).join('')
  const body = rows
    .map((r, i) => `<tr>${columns.map(([, render]) => `<td>${render(r, i)}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

/** Wire the shared header: worker/indexer health badges, refreshed on an interval. */
function mountHeader(active) {
  const nav = [
    ['index.html', '전송'],
    ['holds.html', '보류 패킷'],
    ['overview.html', '종합 현황'],
    ['graph.html', '그래프'],
  ]
  $('#nav').innerHTML = nav
    .map(([href, label]) => `<a href="${href}" class="${href === active ? 'on' : ''}">${label}</a>`)
    .join('')

  /** name + a coloured dot. Detail that used to sit in the label moves to the hover title. */
  const lamp = (name, kind, title) =>
    `<span class="lamp" title="${title}">${name}<i class="dot ${kind}"></i></span>`

  async function refresh() {
    const lamps = []
    try {
      const s = await workerApi('/status')
      const kind = s.state === 'READY' ? 'ok' : s.state === 'HALTED' ? 'bad' : 'warn'
      const degraded = s.degraded && s.degraded.length ? `, 축소운영: ${s.degraded.join(',')}` : ''
      lamps.push(lamp('worker', kind, `${s.state}${degraded}`))
    } catch {
      lamps.push(lamp('worker', 'bad', '중지 — cd worker && pnpm start 으로 실행하세요'))
    }
    try {
      const s = await indexerApi('/api/status')
      const feed = s.feed ? `피드 v${s.feed.version}, ${s.feed.entries}건` : '피드 없음'
      lamps.push(lamp('indexer', 'ok', `가동 중 · ${feed} · 정책 v${s.policyVersion} · 시드 ${s.seeds}건`))
    } catch {
      lamps.push(lamp('indexer', 'bad', '중지'))
    }
    $('#health').innerHTML = lamps.join('')
  }
  refresh()
  setInterval(refresh, 15000)
}
