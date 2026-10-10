import CFB from "cfb";

/**
 * Minimal Outlook .msg writer for tests and the synthetic sample corpus.
 *
 * Produces an OLE compound file following [MS-OXMSG]: a top-level property stream, string and
 * binary properties as __substg1.0_* streams, recipient and attachment storages, and embedded
 * messages (PR_ATTACH_METHOD = 5) in __substg1.0_3701000D storages. It writes only the
 * properties this project reads; it is not a general-purpose MSG writer.
 */

export interface MsgAddress {
  name: string;
  address: string;
}

export interface MsgFileAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface MsgEmbeddedAttachment {
  displayName: string;
  message: MsgSpec;
}

export interface MsgSpec {
  subject: string;
  from: MsgAddress;
  to: MsgAddress[];
  cc?: MsgAddress[];
  bcc?: MsgAddress[];
  /** Sending instant. */
  sentAt: Date;
  /** Sender's UTC offset in minutes, used for the transport Date header (default 0). */
  utcOffsetMinutes?: number;
  messageId: string;
  inReplyTo?: string;
  body: string;
  attachments?: (MsgFileAttachment | MsgEmbeddedAttachment)[];
  /** Include PR_TRANSPORT_MESSAGE_HEADERS (default true). Drafts and some exports lack them. */
  transportHeaders?: boolean;
}

const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000b;
const PT_OBJECT = 0x000d;
const PT_UNICODE = 0x001f;
const PT_SYSTIME = 0x0040;
const PT_BINARY = 0x0102;

type Prop =
  | { id: number; type: typeof PT_UNICODE; value: string }
  | { id: number; type: typeof PT_BINARY; value: Uint8Array }
  | { id: number; type: typeof PT_LONG | typeof PT_BOOLEAN; value: number }
  | { id: number; type: typeof PT_SYSTIME; value: Date }
  | { id: number; type: typeof PT_OBJECT };

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");

function fileTime(date: Date): bigint {
  return (BigInt(date.getTime()) + 11_644_473_600_000n) * 10_000n;
}

/** Write a property set into `dir` (a storage path ending in "/") of the container. */
function writeProps(cfb: CFB.CFB$Container, dir: string, props: Prop[], header: Buffer): void {
  const entries: Buffer[] = [header];
  for (const p of props) {
    const tag = ((p.id << 16) | p.type) >>> 0;
    const e = Buffer.alloc(16);
    e.writeUInt32LE(tag, 0);
    e.writeUInt32LE(0x6, 4); // PROPATTR_READABLE | PROPATTR_WRITABLE
    switch (p.type) {
      case PT_UNICODE: {
        const data = Buffer.from(`${p.value}\u0000`, "utf16le");
        CFB.utils.cfb_add(cfb, `${dir}__substg1.0_${hex4(p.id)}${hex4(p.type)}`, data);
        e.writeUInt32LE(data.length, 8);
        break;
      }
      case PT_BINARY: {
        CFB.utils.cfb_add(cfb, `${dir}__substg1.0_${hex4(p.id)}${hex4(p.type)}`, Buffer.from(p.value));
        e.writeUInt32LE(p.value.length, 8);
        break;
      }
      case PT_LONG:
      case PT_BOOLEAN:
        e.writeInt32LE(p.value, 8);
        break;
      case PT_SYSTIME:
        e.writeBigUInt64LE(fileTime(p.value), 8);
        break;
      case PT_OBJECT:
        e.writeUInt32LE(0xffffffff, 8);
        break;
    }
    entries.push(e);
  }
  CFB.utils.cfb_add(cfb, `${dir}__properties_version1.0`, Buffer.concat(entries));
}

function rfc2822(date: Date, offsetMinutes: number): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${days[local.getUTCDay()]}, ${local.getUTCDate()} ${months[local.getUTCMonth()]} ${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

const fmt = (a: MsgAddress) => `"${a.name}" <${a.address}>`;

function writeMessage(cfb: CFB.CFB$Container, dir: string, spec: MsgSpec, topLevel: boolean): void {
  const recipients = [
    ...spec.to.map((a) => ({ a, type: 1 })),
    ...(spec.cc ?? []).map((a) => ({ a, type: 2 })),
    ...(spec.bcc ?? []).map((a) => ({ a, type: 3 })),
  ];
  const attachments = spec.attachments ?? [];

  const headers = [
    `From: ${fmt(spec.from)}`,
    `To: ${spec.to.map(fmt).join(", ")}`,
    spec.cc?.length ? `Cc: ${spec.cc.map(fmt).join(", ")}` : null,
    `Subject: ${spec.subject}`,
    `Date: ${rfc2822(spec.sentAt, spec.utcOffsetMinutes ?? 0)}`,
    `Message-ID: ${spec.messageId}`,
    spec.inReplyTo ? `In-Reply-To: ${spec.inReplyTo}` : null,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed",
  ]
    .filter(Boolean)
    .join("\r\n");

  const props: Prop[] = [
    { id: 0x001a, type: PT_UNICODE, value: "IPM.Note" },
    { id: 0x0037, type: PT_UNICODE, value: spec.subject },
    { id: 0x0e1d, type: PT_UNICODE, value: spec.subject },
    { id: 0x0070, type: PT_UNICODE, value: spec.subject },
    { id: 0x0c1a, type: PT_UNICODE, value: spec.from.name },
    { id: 0x0c1e, type: PT_UNICODE, value: "SMTP" },
    { id: 0x0c1f, type: PT_UNICODE, value: spec.from.address },
    { id: 0x5d01, type: PT_UNICODE, value: spec.from.address },
    { id: 0x0042, type: PT_UNICODE, value: spec.from.name },
    { id: 0x0065, type: PT_UNICODE, value: spec.from.address },
    { id: 0x1000, type: PT_UNICODE, value: spec.body },
    { id: 0x1035, type: PT_UNICODE, value: spec.messageId },
    { id: 0x0039, type: PT_SYSTIME, value: spec.sentAt },
    { id: 0x0e06, type: PT_SYSTIME, value: new Date(spec.sentAt.getTime() + 60_000) },
    { id: 0x0e07, type: PT_LONG, value: 1 },
    { id: 0x0e1b, type: PT_BOOLEAN, value: attachments.length ? 1 : 0 },
  ];
  if (spec.inReplyTo) props.push({ id: 0x1042, type: PT_UNICODE, value: spec.inReplyTo });
  if (spec.transportHeaders !== false) props.push({ id: 0x007d, type: PT_UNICODE, value: `${headers}\r\n\r\n` });

  const header = Buffer.alloc(topLevel ? 32 : 24);
  header.writeUInt32LE(recipients.length, 8);
  header.writeUInt32LE(attachments.length, 12);
  header.writeUInt32LE(recipients.length, 16);
  header.writeUInt32LE(attachments.length, 20);
  writeProps(cfb, dir, props, header);

  recipients.forEach(({ a, type }, i) => {
    writeProps(
      cfb,
      `${dir}__recip_version1.0_#${hex8(i)}/`,
      [
        { id: 0x0c15, type: PT_LONG, value: type },
        { id: 0x3001, type: PT_UNICODE, value: a.name },
        { id: 0x3002, type: PT_UNICODE, value: "SMTP" },
        { id: 0x3003, type: PT_UNICODE, value: a.address },
        { id: 0x39fe, type: PT_UNICODE, value: a.address },
        { id: 0x3000, type: PT_LONG, value: i },
      ],
      Buffer.alloc(8),
    );
  });

  attachments.forEach((att, i) => {
    const adir = `${dir}__attach_version1.0_#${hex8(i)}/`;
    if ("message" in att) {
      writeMessage(cfb, `${adir}__substg1.0_3701000D/`, att.message, false);
      writeProps(
        cfb,
        adir,
        [
          { id: 0x3705, type: PT_LONG, value: 5 },
          { id: 0x3001, type: PT_UNICODE, value: att.displayName },
          { id: 0x3701, type: PT_OBJECT },
          { id: 0x0e21, type: PT_LONG, value: i },
        ],
        Buffer.alloc(8),
      );
    } else {
      writeProps(
        cfb,
        adir,
        [
          { id: 0x3705, type: PT_LONG, value: 1 },
          { id: 0x3707, type: PT_UNICODE, value: att.filename },
          { id: 0x3704, type: PT_UNICODE, value: att.filename.slice(0, 12) },
          { id: 0x3001, type: PT_UNICODE, value: att.filename },
          { id: 0x370e, type: PT_UNICODE, value: att.mimeType },
          { id: 0x3701, type: PT_BINARY, value: att.data },
          { id: 0x0e20, type: PT_LONG, value: att.data.length },
          { id: 0x0e21, type: PT_LONG, value: i },
        ],
        Buffer.alloc(8),
      );
    }
  });
}

export function buildMsg(spec: MsgSpec): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  writeMessage(cfb, "/", spec, true);
  for (const s of ["00020102", "00030102", "00040102"]) {
    CFB.utils.cfb_add(cfb, `/__nameid_version1.0/__substg1.0_${s}`, Buffer.alloc(0));
  }
  CFB.utils.cfb_del(cfb, "/\u0001Sh33tJ5");
  return Uint8Array.from(CFB.write(cfb, { type: "buffer", fileType: "cfb" }) as Buffer);
}
