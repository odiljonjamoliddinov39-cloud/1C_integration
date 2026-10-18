import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { attachTimestampToken, describeBer, readTimestampToken, stampsSignature } from "./cms.js";

// A real CMS signature as `openssl cms -sign -stream` writes it (BER, indefinite lengths, like E-IMZO's),
// made with a throwaway key, and a real RFC 3161 time stamp token (`openssl ts`) from a throwaway TSA.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim();
const SIGNED = fixture("cms-signed.b64");
const TOKEN = fixture("cms-timestamp-token.b64");

type Tree = [number, Tree[] | string];
const tree = (base64: string) => describeBer(Buffer.from(base64, "base64")) as Tree;
const children = (node: Tree) => node[1] as Tree[];

/** ContentInfo → [0] → SignedData → its last child, the signerInfos → the first SignerInfo. */
const signerOf = (root: Tree) => {
  const signedData = children(children(children(root)[1] as Tree)[0] as Tree);
  return children(signedData.at(-1) as Tree)[0] as Tree;
};

describe("attaching a time stamp token to a PKCS#7", () => {
  it("adds the token to the signer's unsigned attributes and changes nothing else", () => {
    const stamped = attachTimestampToken(SIGNED, TOKEN);
    const before = signerOf(tree(SIGNED));
    const after = signerOf(tree(stamped));
    // Everything the signer signed (its attributes, the signature) is as it was; one child was added: [1].
    expect(children(after).slice(0, -1)).toEqual(children(before));
    const added = children(after).at(-1) as Tree;
    expect(added[0]).toBe(0xa1);
    // The attribute: id-aa-signatureTimeStampToken (1.2.840.113549.1.9.16.2.14), then a SET holding the token.
    const attribute = children(added)[0] as Tree;
    expect(children(attribute)[0]).toEqual([0x06, "2a864886f70d010910020e"]);
    const token = children(children(attribute)[1] as Tree)[0] as Tree;
    expect(token[0]).toBe(0x30);
    // The signed content is untouched too.
    expect(JSON.stringify(tree(stamped)).includes(JSON.stringify(tree(SIGNED)).slice(1, 200))).toBe(true);
  });

  it("writes definite lengths, and a document that parses again", () => {
    const stamped = Buffer.from(attachTimestampToken(SIGNED, TOKEN), "base64");
    // The BER input began 30 80 (indefinite); the output is 30 <definite length>.
    expect(Buffer.from(SIGNED, "base64").subarray(0, 2).toString("hex")).toBe("3080");
    expect(stamped[1]).not.toBe(0x80);
    expect(() => describeBer(stamped)).not.toThrow();
  });

  it("adds to the unsigned attributes the signer already has, instead of a second set", () => {
    const once = attachTimestampToken(SIGNED, TOKEN);
    const twice = attachTimestampToken(once, TOKEN);
    const signer = signerOf(tree(twice));
    expect(children(signer).filter((c) => c[0] === 0xa1)).toHaveLength(1);
    expect(children(children(signer).at(-1) as Tree)).toHaveLength(2);
  });

  it("says what is wrong when it is not a PKCS#7 or the token is not a DER document", () => {
    expect(() => attachTimestampToken(Buffer.from("hello").toString("base64"), TOKEN)).toThrow();
    expect(() => attachTimestampToken(SIGNED, Buffer.from("not der").toString("base64"))).toThrow(
      /time stamp token/,
    );
  });

  describe("reading a time stamp token", () => {
    // The token stamps the data {"authId":"abc"} (sha256), as the throwaway TSA was asked.
    const stamped = Buffer.from('{"authId":"abc"}').toString("hex");

    it("reads what the token says it stamps, and compares it with a signature", () => {
      const token = readTimestampToken(TOKEN);
      expect(token).toMatchObject({ wasResponse: false, algorithm: "sha256" });
      expect(stampsSignature(token as never, stamped)).toBe("yes");
      expect(stampsSignature(token as never, "00ff")).toBe("no");
    });

    it("unwraps a TimeStampResp (a status, then the token) into the token itself", () => {
      const response = readTimestampToken(fixture("cms-timestamp-response.b64"));
      expect(response?.wasResponse).toBe(true);
      expect(response?.contentInfo).toBe(TOKEN);
    });

    it("says nothing about what is not a token", () => {
      expect(readTimestampToken(Buffer.from("not a token").toString("base64"))).toBeNull();
    });
  });
});
