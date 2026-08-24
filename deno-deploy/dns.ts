// Cliente DNS-over-HTTPS (RFC 8484) minimalista: só resolve registros A,
// com suporte opcional a EDNS Client Subnet (ECS). Mesma lógica usada no
// port do Cloudflare Workers — Deno Deploy também não expõe DNS bruto/UDP
// pra código de usuário, então DoH é o jeito confiável de fazer isso.

function encodeDomain(domain: string): number[] {
  const parts = domain.split('.').filter(Boolean);
  const bytes: number[] = [];
  for (const part of parts) {
    const buf = new TextEncoder().encode(part);
    bytes.push(buf.length, ...buf);
  }
  bytes.push(0);
  return bytes;
}

function ipv4ToBytes(ip: string): number[] {
  return ip.split('.').map(Number);
}

function buildQuery(domain: string, ecsSubnet?: string): Uint8Array {
  const id = Math.floor(Math.random() * 65536);
  const header = [
    (id >> 8) & 0xff, id & 0xff,
    0x01, 0x00,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    0x00, ecsSubnet ? 0x01 : 0x00,
  ];
  const question = [...encodeDomain(domain), 0x00, 0x01, 0x00, 0x01];

  let additional: number[] = [];
  if (ecsSubnet) {
    const [ip, prefixStr] = ecsSubnet.split('/');
    const prefix = parseInt(prefixStr, 10);
    const fullBytes = ipv4ToBytes(ip);
    const addressByteCount = Math.ceil(prefix / 8);
    const addressBytes = fullBytes.slice(0, addressByteCount);
    const optionData = [0x00, 0x01, prefix, 0x00, ...addressBytes];
    const rdata = [
      0x00, 0x08,
      (optionData.length >> 8) & 0xff, optionData.length & 0xff,
      ...optionData,
    ];
    additional = [
      0x00,
      0x00, 0x29,
      0x10, 0x00,
      0x00, 0x00, 0x00, 0x00,
      (rdata.length >> 8) & 0xff, rdata.length & 0xff,
      ...rdata,
    ];
  }

  return new Uint8Array([...header, ...question, ...additional]);
}

function readName(view: DataView, offset: number): number {
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

function parseARecords(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  let offset = 12;

  for (let i = 0; i < qdcount; i++) {
    offset = readName(view, offset);
    offset += 4;
  }

  const ips: string[] = [];
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

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function resolveA(dohEndpoint: string, domain: string, ecsSubnet?: string): Promise<string[]> {
  const query = buildQuery(domain, ecsSubnet);
  const url = `${dohEndpoint}?dns=${toBase64Url(query)}`;
  const resp = await fetch(url, { headers: { accept: 'application/dns-message' } });
  if (!resp.ok) throw new Error(`DoH respondeu HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  return parseARecords(buf);
}
