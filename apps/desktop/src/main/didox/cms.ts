/**
 * Attaches a time stamp token to a PKCS#7 (CMS SignedData) document, for an E-IMZO that lacks its own
 * `attach_timestamp_token_pkcs7` ("Функция не найдена или версия E-IMZO устарела"). The token goes into the
 * signer's unsigned attributes (id-aa-signatureTimeStampToken, RFC 3161 / CMS), which the signature does
 * not cover, so nothing the signer signed changes.
 *
 * E-IMZO writes BER with indefinite lengths. The document is read as a tree of tags and values and
 * written again with definite lengths; the values themselves (the signed content, the signed attributes,
 * the signature) are copied byte for byte.
 */

import { createHash } from "node:crypto";

interface Node {
  /** The tag byte as it stands (class, constructed bit, number below 31). */
  tag: number;
  /** Children of a constructed node. */
  children?: Node[];
  /** The content of a primitive node. */
  value?: Buffer;
  /** Bytes taken as they are (a whole encoded node, e.g. the token). */
  raw?: Buffer;
}

const CONSTRUCTED = 0x20;

function readNode(buf: Buffer, at: number): { node: Node; end: number } {
  const tag = buf[at];
  if (tag === undefined) throw new Error("the PKCS#7 ends where a tag was expected");
  if ((tag & 0x1f) === 0x1f) throw new Error("a tag number of 31 or more is not expected in a PKCS#7");
  let pos = at + 1;
  const first = buf[pos++];
  if (first === undefined) throw new Error("the PKCS#7 ends where a length was expected");
  if (tag & CONSTRUCTED) {
    const children: Node[] = [];
    if (first === 0x80) {
      // Indefinite length: children until the end-of-contents marker 00 00.
      while (!(buf[pos] === 0 && buf[pos + 1] === 0)) {
        const child = readNode(buf, pos);
        children.push(child.node);
        pos = child.end;
      }
      return { node: { tag, children }, end: pos + 2 };
    }
    const length = lengthOf(buf, first, pos);
    pos = length.next;
    const end = pos + length.value;
    while (pos < end) {
      const child = readNode(buf, pos);
      children.push(child.node);
      pos = child.end;
    }
    if (pos !== end) throw new Error("a length in the PKCS#7 does not fit its content");
    return { node: { tag, children }, end };
  }
  if (first === 0x80) throw new Error("an indefinite length on a primitive value");
  const length = lengthOf(buf, first, pos);
  const end = length.next + length.value;
  if (end > buf.length) throw new Error("the PKCS#7 is cut short");
  return { node: { tag, value: buf.subarray(length.next, end) }, end };
}

function lengthOf(buf: Buffer, first: number, pos: number): { value: number; next: number } {
  if (first < 0x80) return { value: first, next: pos };
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new Error("a length in the PKCS#7 is not usable");
  let value = 0;
  for (let i = 0; i < count; i++) value = value * 256 + (buf[pos + i] ?? 0);
  return { value, next: pos + count };
}

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function writeNode(node: Node): Buffer {
  if (node.raw) return node.raw;
  const content = node.children
    ? Buffer.concat(node.children.map(writeNode))
    : (node.value ?? Buffer.alloc(0));
  return Buffer.concat([Buffer.from([node.tag]), lengthBytes(content.length), content]);
}

const primitive = (tag: number, value: Buffer): Node => ({ tag, value });
const constructed = (tag: number, children: Node[]): Node => ({ tag: tag | CONSTRUCTED, children });

/** OID 1.2.840.113549.1.9.16.2.14 (id-aa-signatureTimeStampToken), encoded. */
const SIGNATURE_TIME_STAMP_TOKEN = Buffer.from("2a864886f70d010910020e", "hex");
const SEQUENCE = 0x30;
const SET = 0x31;
const OID = 0x06;
/** [1] IMPLICIT, constructed: the signer's unsigned attributes. */
const UNSIGNED_ATTRIBUTES = 0xa1;

/**
 * The PKCS#7 (base64) with the time stamp token (base64, a DER TimeStampToken) added to the signature of
 * each signer. Throws an Error naming what is not as expected.
 */
export function attachTimestampToken(pkcs7Base64: string, tokenBase64: string): string {
  const document = Buffer.from(pkcs7Base64, "base64");
  const token = Buffer.from(tokenBase64, "base64");
  if (token.length === 0 || token[0] !== SEQUENCE)
    throw new Error("the time stamp token is not a DER document");

  const root = readNode(document, 0).node;
  // ContentInfo { contentType, [0] { SignedData } }
  const signedData = root.children?.[1]?.children?.[0];
  if (root.tag !== SEQUENCE || signedData?.tag !== SEQUENCE || !signedData.children) {
    throw new Error("this is not a PKCS#7 SignedData document");
  }
  // SignedData { version, digestAlgorithms, encapContentInfo, [0] certificates?, [1] crls?, signerInfos }
  const signerInfos = signedData.children.at(-1);
  if (signerInfos?.tag !== SET || !signerInfos.children?.length) throw new Error("the PKCS#7 has no signer");

  const attribute = constructed(SEQUENCE, [
    primitive(OID, SIGNATURE_TIME_STAMP_TOKEN),
    constructed(SET, [{ tag: SEQUENCE, raw: token }]),
  ]);
  for (const signer of signerInfos.children) {
    if (signer.tag !== SEQUENCE || !signer.children)
      throw new Error("a signer in the PKCS#7 is not as expected");
    const unsigned = signer.children.find((c) => c.tag === UNSIGNED_ATTRIBUTES);
    if (unsigned?.children) unsigned.children.push(attribute);
    else signer.children.push(constructed(0x81, [attribute]));
  }
  return writeNode(root).toString("base64");
}

/** For tests: the tree of an encoded document as nested [tag, children | value-hex] pairs. */
export function describeBer(buf: Buffer): unknown {
  const show = (node: Node): unknown =>
    node.children ? [node.tag, node.children.map(show)] : [node.tag, node.value?.toString("hex")];
  return show(readNode(buf, 0).node);
}

/** Decodes the content bytes of an OBJECT IDENTIFIER: "1.2.840.113549.1.9.16.2.14". */
function oidText(value: Buffer): string {
  const first = value[0] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let n = 0;
  for (const byte of value.subarray(1)) {
    n = n * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

const HASHES: Record<string, string> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.4": "sha224",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};

export interface TimeStampToken {
  /** The token as a CMS ContentInfo (base64), which is what a signature carries. */
  contentInfo: string;
  /** Whether it came as a TimeStampResp (the token wrapped in a status), which is unwrapped. */
  wasResponse: boolean;
  /** The hash algorithm of its message imprint (a name when known, else the OID), and the imprint in hex. */
  algorithm: string;
  imprint: string;
}

/** The OCTET STRING content of a node, whole or in chunks. */
function octets(node: Node | undefined): Buffer {
  if (!node) return Buffer.alloc(0);
  if (node.children) return Buffer.concat(node.children.map(octets));
  return node.value ?? Buffer.alloc(0);
}

/**
 * Reads a time stamp token: a CMS ContentInfo (SignedData) holding a TSTInfo, or a TimeStampResp that wraps
 * one (a status, then the token). Null when it is neither. The imprint is what the token says it stamps.
 */
export function readTimestampToken(tokenBase64: string): TimeStampToken | null {
  try {
    const bytes = Buffer.from(tokenBase64, "base64");
    let root = readNode(bytes, 0).node;
    let wasResponse = false;
    // TimeStampResp { PKIStatusInfo (a SEQUENCE), TimeStampToken }
    if (root.children?.[0]?.tag === SEQUENCE && root.children[1]) {
      root = root.children[1];
      wasResponse = true;
    }
    if (root.children?.[0]?.tag !== OID) return null;
    // ContentInfo { OID, [0] { SignedData { version, digestAlgorithms, encapContentInfo, … } } }
    const encap = root.children[1]?.children?.[0]?.children?.[2];
    const tstInfo = readNode(octets(encap?.children?.[1]?.children?.[0]), 0).node;
    // TSTInfo { version, policy, messageImprint { hashAlgorithm { OID }, hashedMessage }, … }
    const imprint = tstInfo.children?.[2];
    const algorithm = oidText(imprint?.children?.[0]?.children?.[0]?.value ?? Buffer.alloc(0));
    const hashed = octets(imprint?.children?.[1]);
    if (hashed.length === 0) return null;
    return {
      contentInfo: writeNode(root).toString("base64"),
      wasResponse,
      algorithm: HASHES[algorithm] ?? algorithm,
      imprint: hashed.toString("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Whether the token stamps this signature: its imprint is the hash of the signature value. "unknown" when
 * the hash is not one Node has (a national algorithm), "no" when it is and the imprint differs.
 */
export function stampsSignature(token: TimeStampToken, signatureHex: string): "yes" | "no" | "unknown" {
  if (!Object.values(HASHES).includes(token.algorithm)) return "unknown";
  const hash = (data: Buffer) => createHash(token.algorithm).update(data).digest("hex");
  return hash(Buffer.from(signatureHex, "hex")) === token.imprint ? "yes" : "no";
}
