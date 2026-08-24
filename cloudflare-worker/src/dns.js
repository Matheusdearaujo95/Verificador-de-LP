// Cliente DNS-over-HTTPS (RFC 8484) minimalista: só resolve registros A,
// com suporte opcional a EDNS Client Subnet (ECS) pra simular a origem
// geográfica da consulta. Escrito à mão porque Workers não tem uma API de
// DNS bruto (nem UDP) como o Python tem.

function encodeDomain(domain) {
  const parts = domain.split('.').filter(Boolean);
  const bytes = [];
  for (const part of parts) {
    const buf = new TextEncoder().encode(part);
    bytes.push(buf.length, ...buf);
  }
  bytes.push(0);
  return bytes;
}

function ipv4ToBytes(ip) {
  return ip.split('.').map(Number);
}

function buildQuery(domain, ecsSubnet) {
  const id = Math.floor(Math.random() * 65536);
  const header = [
    (id >> 8) & 0xff, id & 0xff,
    0x01, 0x00, // flags: RD=1
    0x00, 0x01, // QDCOUNT=1
    0x00, 0x00, // ANCOUNT
    0x00, 0x00, // NSCOUNT
    0x00, ecsSubnet ? 0x01 : 0x00, // ARCOUNT
  ];
  const question = [...encodeDomain(domain), 0x00, 0x01, 0x00, 0x01]; // QTYPE=A, QCLASS=IN

  let additional = [];
  if (ecsSubnet) {
    const [ip, prefixStr] = ecsSubnet.split('/');
    const prefix = parseInt(prefixStr, 10);
    const fullBytes = ipv4ToBytes(ip);
    const addressByteCount = Math.ceil(prefix / 8);
    const addressBytes = fullBytes.slice(0, addressByteCount);
    const optionData = [0x00, 0x01, prefix, 0x00, ...addressBytes];
    const rdata = [
      0x00, 0x08, // option code 8 = ECS
      (optionData.length >> 8) & 0xff, optionData.length & 0xff,
      ...optionData,
    ];
    additional = [
      0x00, // NAME = root
      0x00, 0x29, // TYPE = OPT (41)
      0x10, 0x00, // CLASS = UDP payload size (4096)
      0x00, 0x00, 0x00, 0x00, // TTL (extended rcode/version/flags)
      (rdata.length >> 8) & 0xff, rdata.length & 0xff,
      ...rdata,
    ];
  }

  return new Uint8Array([...header, ...question, ...additional]);
}

function readName(view, offset) {
  let jumped = false;
  let cursor = offset;
  let safety = 0;
  while (true) {
    if (safety++ > 100) throw new Error('nome DNS malformado');
    const len = view.getUint8(cursor);
    if (len === 0) {
      cursor += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) offset = cursor + 2;
      cursor = ((len & 0x3f) << 8) | view.getUint8(cursor + 1);
      jumped = true;
      continue;
    }
    cursor += 1 + len;
  }
  return jumped ? offset : cursor;
}

function parseARecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  let offset = 12;

  for (let i = 0; i < qdcount; i++) {
    offset = readName(view, offset);
    offset += 4; // QTYPE + QCLASS
  }

  const ips = [];
  for (let i = 0; i < ancount; i++) {
    offset = readName(view, offset);
    const type = view.getUint16(offset);
    const rdlength = view.getUint16(offset + 8);
    const rdataOffset = offset + 10;
    if (type === 1 && rdlength === 4) {
      ips.push(
        `${view.getUint8(rdataOffset)}.${view.getUint8(rdataOffset + 1)}.` +
        `${view.getUint8(rdataOffset + 2)}.${view.getUint8(rdataOffset + 3)}`
      );
    }
    offset = rdataOffset + rdlength;
  }
  return ips;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function resolveA(dohEndpoint, domain, ecsSubnet) {
  const query = buildQuery(domain, ecsSubnet);
  const url = `${dohEndpoint}?dns=${toBase64Url(query)}`;
  const resp = await fetch(url, { headers: { accept: 'application/dns-message' } });
  if (!resp.ok) throw new Error(`DoH respondeu HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  return parseARecords(buf);
}
