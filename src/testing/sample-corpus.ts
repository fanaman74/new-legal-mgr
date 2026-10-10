import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { buildMsg } from "./msg-writer.js";

/**
 * Synthetic, entirely fictional sample corpus used by tests and for trying the POC.
 *
 * "Example Agency", "Jane Doe" and all other names, references and events are invented.
 * Facts deliberately overlap across documents (dates, the Article 24 request, the audit
 * report, annexes) so that cross-document retrieval and analysis can be exercised later.
 */

type PdfBlock = { h?: string; p?: string; size?: number } | "pagebreak";

const FIXED_DATE = new Date("2025-06-30T12:00:00Z");

export async function makePdf(blocks: PdfBlock[], title?: string): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: "A4", margin: 64, info: { Title: title ?? "", Producer: "sample-corpus", Creator: "sample-corpus", CreationDate: FIXED_DATE } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  for (const b of blocks) {
    if (b === "pagebreak") {
      doc.addPage();
      continue;
    }
    if (b.h) doc.font("Helvetica-Bold").fontSize(b.size ?? 14).text(b.h).moveDown(0.6);
    if (b.p) doc.font("Helvetica").fontSize(b.size ?? 11).text(b.p, { align: "left" }).moveDown(0.8);
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

/** Build an image-only ("scanned") PDF: render a text PDF to PNG, then embed only the image. */
export async function makeScannedPdf(blocks: PdfBlock[]): Promise<Uint8Array> {
  const textPdf = await makePdf(blocks);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(textPdf), verbosity: 0 });
  const src = await loadingTask.promise;
  const images: Buffer[] = [];
  for (let p = 1; p <= src.numPages; p++) {
    const page = await src.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    // A light grey tint so the page looks like a scan.
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "#f2f0ea";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    images.push(canvas.toBuffer("image/png"));
  }
  await loadingTask.destroy();

  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, info: { Producer: "Scanner XYZ", Creator: "Scanner XYZ", CreationDate: FIXED_DATE } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  for (const img of images) {
    doc.addPage({ size: "A4", margin: 0 });
    doc.image(img, 0, 0, { width: doc.page.width, height: doc.page.height });
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

export async function makeDocx(args: { title: string; creator: string; blocks: { h?: string; level?: 1 | 2; p?: string; bullets?: string[] }[] }): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  for (const b of args.blocks) {
    if (b.h) children.push(new Paragraph({ text: b.h, heading: b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1 }));
    if (b.p) children.push(new Paragraph({ children: [new TextRun(b.p)] }));
    for (const item of b.bullets ?? []) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
  }
  const doc = new Document({ title: args.title, creator: args.creator, sections: [{ children }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export function makeEml(args: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  messageId: string;
  inReplyTo?: string;
  body: string;
  attachments?: { filename: string; contentType: string; data: Uint8Array }[];
}): Uint8Array {
  const boundary = "----=_Part_SAMPLE_0001";
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    ...(args.cc ? [`Cc: ${args.cc}`] : []),
    `Subject: ${args.subject}`,
    `Date: ${args.date}`,
    `Message-ID: ${args.messageId}`,
    ...(args.inReplyTo ? [`In-Reply-To: ${args.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    args.body,
  ];
  for (const a of args.attachments ?? []) {
    const b64 = Buffer.from(a.data).toString("base64").replace(/.{76}/g, "$&\r\n");
    lines.push(`--${boundary}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.filename}"`, "", b64);
  }
  lines.push(`--${boundary}--`, "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

const JANE = { name: "Jane Doe", address: "jane.doe@example.org" };
const HR = { name: "HR Unit B.2", address: "hr-b2@agency.example.org" };
const HEAD_HR = { name: "Paul Martin", address: "paul.martin@agency.example.org" };
const COUNSEL = { name: "Maître Anne Leroy", address: "a.leroy@lawfirm.example.org" };

export interface SampleFile {
  relativePath: string;
  description: string;
}

/** Write the sample corpus into `dir` (which must be empty or not exist). */
export async function generateSampleCorpus(dir: string): Promise<SampleFile[]> {
  if (existsSync(dir) && readdirSync(dir).filter((f) => f !== ".gitkeep").length) {
    throw new Error(`Refusing to generate the sample corpus into a non-empty directory: ${dir}`);
  }
  const files: SampleFile[] = [];
  const write = (rel: string, data: Uint8Array, description: string) => {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, data);
    files.push({ relativePath: rel, description });
  };

  const request = await makePdf(
    [
      { h: "REQUEST FOR ASSISTANCE UNDER ARTICLE 24 OF THE STAFF REGULATIONS", size: 15 },
      { p: "Brussels, 17 January 2025" },
      { p: "From: Jane Doe, Procurement Officer, Unit C.3\nTo: The Appointing Authority, Example Agency" },
      { h: "1. Subject of the request" },
      {
        p: "I hereby submit a request for assistance under Article 24 of the Staff Regulations concerning the conduct of my line manager, Mr Victor Hale, between September 2024 and January 2025. I respectfully request that the Agency open an administrative inquiry and take measures to protect me.",
      },
      { h: "2. Facts" },
      {
        p: "On 3 December 2024 Mr Hale sent me an email stating that I was personally responsible for the procurement irregularities identified by the Internal Audit Service. A copy of that email is provided as Annex C.",
      },
      {
        p: "The IAS audit report IAS-2024-07 of 30 September 2024 does not attribute any shortcoming to me personally. Its findings concern the design of the procurement workflow.",
      },
      "pagebreak",
      { h: "3. Evidence submitted" },
      { p: "Annex A: medical certificate dated 2 December 2024 (sick leave from 2 to 20 December 2024).\nAnnex B: witness statement of Ms Maria Rossi dated 10 January 2025.\nAnnex C: email from Mr Hale of 3 December 2024." },
      { h: "4. Request" },
      { p: "I ask the Appointing Authority to recognise that the conditions of Article 24 are met and to adopt appropriate measures within the statutory time limit." },
      { p: "Jane Doe" },
    ],
    "Request for assistance - Article 24",
  );
  write("article24/2025-01-17_request_for_assistance_article24.pdf", request, "Complainant's Article 24 request (2 pages)");
  write("article24/copy_of_request_for_assistance.pdf", request, "Byte-identical duplicate of the Article 24 request");

  write(
    "article24/2025-01-20_acknowledgement_of_registration.pdf",
    await makePdf([
      { h: "EXAMPLE AGENCY - HUMAN RESOURCES", size: 14 },
      { p: "Date: 20 January 2025\nOur ref.: ART24-2025-0012" },
      {
        p: "Dear Ms Doe,\n\nWe acknowledge receipt of your request for assistance under Article 24 of the Staff Regulations, submitted on 17 January 2025. Your request has been registered under reference ART24-2025-0012. The Appointing Authority will reply within four months.",
      },
      { p: "Paul Martin\nHead of Unit, HR B.2" },
    ]),
    "Acknowledgement / registration of the request (1 page)",
  );

  write(
    "article24/2025-05-12_decision_on_request_for_assistance.pdf",
    await makePdf(
      [
        { h: "DECISION OF THE APPOINTING AUTHORITY", size: 15 },
        { p: "Brussels, 12 May 2025\nRef.: ART24-2025-0012" },
        { h: "1. Procedure" },
        { p: "On 17 January 2025 Ms Jane Doe submitted a request for assistance under Article 24 of the Staff Regulations. The request was registered on 20 January 2025." },
        { h: "2. Assessment" },
        {
          p: "The Appointing Authority has examined the medical certificate submitted as Annex A. It notes that the certificate establishes a period of sick leave but does not, in itself, establish a causal link with the conduct complained of.",
        },
        {
          p: "As regards the email of 3 December 2024 (Annex C), the Appointing Authority considers that it expresses a managerial assessment and does not constitute prima facie evidence of harassment.",
        },
        "pagebreak",
        { h: "3. Audit findings" },
        { p: "The IAS audit report identified weaknesses in the procurement workflow for which the Procurement Officer was responsible." },
        { h: "4. Decision" },
        { p: "The Appointing Authority HAS DECIDED: the request for assistance is rejected." },
        { p: "Paul Martin\nfor the Appointing Authority" },
      ],
      "Decision on request for assistance ART24-2025-0012",
    ),
    "Decision rejecting the request (2 pages) - does not discuss Annex B",
  );

  write(
    "article24/annex_A_medical_certificate_scanned.pdf",
    await makeScannedPdf([
      { h: "MEDICAL CERTIFICATE", size: 16 },
      { p: "Date: 2 December 2024", size: 13 },
      { p: "I certify that Ms Jane Doe is unfit for work from 2 December 2024 to 20 December 2024 inclusive.", size: 13 },
      { p: "Dr. Thomas Weber, General Practitioner", size: 13 },
    ]),
    "Scanned (image-only) medical certificate - requires OCR",
  );

  write(
    "audit/IAS_audit_report_2024-07.pdf",
    await makePdf(
      [
        { h: "INTERNAL AUDIT SERVICE", size: 15 },
        { p: "Audit report IAS-2024-07\nFinal version, 30 September 2024" },
        { h: "1. Executive summary" },
        { p: "The Internal Audit Service reviewed the procurement process of Unit C.3 for the period 2022-2024. The audit identified two significant weaknesses in the design of the procurement workflow." },
        { h: "2. Findings" },
        { p: "Finding 1: the workflow does not enforce segregation of duties between the initiating and verifying agents.\nFinding 2: approval thresholds are not configured in the financial system." },
        "pagebreak",
        { h: "3. Attribution" },
        { p: "The findings relate to the design of the process and not to the performance of any individual staff member." },
      ],
      "IAS audit report IAS-2024-07",
    ),
    "Audit report (2 pages)",
  );

  write(
    "termination/2025-02-28_termination_letter.docx",
    await makeDocx({
      title: "Termination letter",
      creator: "Template Author",
      blocks: [
        { h: "Notice of termination of your contract" },
        { p: "Brussels, 28 February 2025" },
        { p: "Dear Ms Doe," },
        { p: "I regret to inform you of the termination of your contract with effect from 31 May 2025, in accordance with Article 47 of the Conditions of Employment." },
        { h: "Reasons", level: 2 },
        { p: "The audit report identified serious shortcomings attributable to you in the management of procurement files." },
        { bullets: ["Repeated failure to apply verification procedures.", "Insufficient documentation of procurement decisions."] },
        { p: "Paul Martin, Head of Unit HR B.2" },
      ],
    }),
    "Termination letter (DOCX) - attributes audit shortcomings to J. Doe",
  );

  write(
    "lawyer/2025-03-15_letter_from_counsel.docx",
    await makeDocx({
      title: "",
      creator: "Law firm",
      blocks: [
        { h: "Letter from counsel" },
        { p: "Brussels, 15 March 2025" },
        { p: "Acting on behalf of my client, Ms Jane Doe, I write concerning the termination letter of 28 February 2025." },
        { h: "The audit report", level: 2 },
        { p: "Contrary to the termination letter, the IAS audit report IAS-2024-07 did not attribute any shortcoming to my client. Section 3 of that report states that the findings relate to the design of the process." },
        { h: "Pending request", level: 2 },
        { p: "My client's request for assistance of 17 January 2025 (ref. ART24-2025-0012) is still pending." },
        { p: "Anne Leroy, Avocat" },
      ],
    }),
    "Lawyer correspondence (DOCX)",
  );

  const witness = await makeDocx({
    title: "Witness statement",
    creator: "Maria Rossi",
    blocks: [
      { h: "Annex B - Witness statement of Maria Rossi" },
      { p: "Date: 10 January 2025" },
      { p: "I, Maria Rossi, was present at the unit meeting of 26 November 2024. During that meeting Mr Hale shouted at Ms Doe in front of colleagues and said that she was incompetent." },
    ],
  });
  write(
    "emails/2025-01-17_submission_of_request.msg",
    buildMsg({
      subject: "Request for assistance under Article 24 - J. Doe",
      from: JANE,
      to: [HR],
      cc: [COUNSEL],
      sentAt: new Date("2025-01-17T16:42:00Z"),
      utcOffsetMinutes: 60,
      messageId: "<20250117164200.jd01@example.org>",
      body: "Dear colleagues,\r\n\r\nPlease find attached my request for assistance under Article 24 of the Staff Regulations, together with Annex B (witness statement of Ms Rossi).\r\n\r\nKind regards,\r\nJane Doe",
      attachments: [
        { filename: "Request_for_assistance_Article24.pdf", mimeType: "application/pdf", data: request },
        { filename: "Annex_B_witness_statement_Rossi.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: witness },
      ],
    }),
    "Outlook .msg submitting the request; attaches the same request PDF + Annex B",
  );

  write(
    "emails/2025-03-20_fwd_hr_position_on_audit.msg",
    buildMsg({
      subject: "FW: Audit report and Ms Doe",
      from: HEAD_HR,
      to: [{ name: "Legal Service", address: "legal@agency.example.org" }],
      sentAt: new Date("2025-03-20T10:05:00Z"),
      utcOffsetMinutes: 60,
      messageId: "<20250320100500.pm02@agency.example.org>",
      body: "For your information, see the internal exchange below on the audit report.\r\n\r\nPaul",
      attachments: [
        {
          displayName: "Audit report - attribution",
          message: {
            subject: "Audit report - attribution",
            from: { name: "Internal Audit Service", address: "ias@agency.example.org" },
            to: [HEAD_HR],
            sentAt: new Date("2024-10-02T08:30:00Z"),
            utcOffsetMinutes: 120,
            messageId: "<20241002083000.ias@agency.example.org>",
            body: "Dear Paul,\r\n\r\nAs requested: the audit report IAS-2024-07 does not name Ms Doe and does not attribute the findings to any individual.\r\n\r\nIAS",
          },
        },
      ],
    }),
    "Outlook .msg forwarding an embedded message (IAS position on attribution)",
  );

  write(
    "emails/2025-02-10_reply_from_hr.eml",
    makeEml({
      from: `"${HEAD_HR.name}" <${HEAD_HR.address}>`,
      to: `"${JANE.name}" <${JANE.address}>`,
      subject: "Re: Request for assistance under Article 24 - J. Doe",
      date: "Mon, 10 Feb 2025 09:12:00 +0100",
      messageId: "<20250210091200.pm01@agency.example.org>",
      inReplyTo: "<20250117164200.jd01@example.org>",
      body: "Dear Ms Doe,\r\n\r\nThe Agency is examining your request ref. ART24-2025-0012. Please find attached a note on the procedure.\r\n\r\nBest regards,\r\nPaul Martin",
      attachments: [
        {
          filename: "Note_on_Article24_procedure.pdf",
          contentType: "application/pdf",
          data: await makePdf([{ h: "Note on the Article 24 procedure" }, { p: "Date: 7 February 2025\nRequests for assistance are examined by HR B.2. The Appointing Authority replies within four months of registration." }]),
        },
      ],
    }),
    "RFC 822 .eml reply with a PDF attachment",
  );

  write(
    "notes/chronology_notes.md",
    new TextEncoder().encode(
      "# Working notes (complainant side)\n\n## Key dates\n\n- 26 November 2024: unit meeting (see Annex B).\n- 3 December 2024: email from Mr Hale (Annex C).\n- 17 January 2025: Article 24 request submitted.\n\n## Open points\n\nCheck whether the decision addresses the witness statement (Annex B).\n",
    ),
    "Markdown notes",
  );

  // ----- Article 90 complaint against the decision ------------------------------------------
  const complaint90 = await makePdf(
    [
      { h: "COMPLAINT UNDER ARTICLE 90(2) OF THE STAFF REGULATIONS", size: 15 },
      { p: "Brussels, 30 July 2025" },
      { p: "From: Jane Doe, represented by Maître Anne Leroy\nTo: The Appointing Authority, Example Agency" },
      { h: "1. Contested decision" },
      { p: "This complaint is directed against the decision of 12 May 2025 rejecting my request for assistance ART24-2025-0012." },
      { h: "2. Grounds" },
      {
        p: "First, the decision does not examine the witness statement of Ms Maria Rossi, although it was submitted with the request. Second, the decision relies on the audit report without considering the email of the Internal Audit Service of 2 October 2024. Third, my health deteriorated as documented by the medical report of 15 June 2025.",
      },
      "pagebreak",
      { h: "3. Annexes" },
      {
        p: "Annex 1: witness statement of Ms Maria Rossi dated 10 January 2025.\nAnnex 2: medical report of Dr Thomas Weber dated 15 June 2025.\nAnnex 3: email of the Internal Audit Service of 2 October 2024.\nAnnex 4: performance appraisal report for 2023.",
      },
      { h: "4. Request" },
      { p: "I request the annulment of the decision of 12 May 2025 and compensation for the damage suffered." },
    ],
    "Complaint under Article 90(2) - J. Doe",
  );
  write("article90/2025-07-30_complaint_article90_against_decision.pdf", complaint90, "Article 90(2) complaint (2 pages) raising Annexes 1-4");
  write(
    "article90/annex_2_medical_report_scanned.pdf",
    await makeScannedPdf([
      { h: "MEDICAL REPORT", size: 16 },
      { p: "Date: 15 June 2025", size: 13 },
      { p: "Ms Jane Doe has been under my care since December 2024. She presents symptoms consistent with work-related stress.", size: 13 },
      { p: "Dr. Thomas Weber, General Practitioner", size: 13 },
    ]),
    "Scanned medical report (Annex 2 of the complaint)",
  );
  write(
    "article90/annex_4_performance_appraisal_2023.docx",
    await makeDocx({
      title: "Appraisal report 2023",
      creator: "HR system",
      blocks: [
        { h: "Performance appraisal report 2023 - Jane Doe" },
        { p: "Date: 31 January 2024" },
        { p: "Overall assessment: the jobholder's performance exceeds expectations. Procurement files were handled with rigour and in compliance with the applicable rules." },
        { p: "Reporting officer: Victor Hale" },
      ],
    }),
    "Annex 4 of the complaint: 2023 appraisal (DOCX)",
  );
  write(
    "article90/2025-08-04_acknowledgement_of_complaint.eml",
    makeEml({
      from: `"${HR.name}" <${HR.address}>`,
      to: `"${COUNSEL.name}" <${COUNSEL.address}>`,
      subject: "Acknowledgement - complaint R/123/25",
      date: "Mon, 4 Aug 2025 11:20:00 +0200",
      messageId: "<20250804112000.hr03@agency.example.org>",
      body: "Dear Maître Leroy,\r\n\r\nWe acknowledge receipt of the complaint under Article 90(2) lodged on behalf of Ms Doe on 30 July 2025. It was registered on 4 August 2025 under reference R/123/25.\r\n\r\nHR Unit B.2",
    }),
    "Email (.eml) acknowledging the Article 90 complaint",
  );
  const reply90 = await makePdf(
    [
      { h: "REPLY TO COMPLAINT R/123/25", size: 15 },
      { p: "Brussels, 28 November 2025" },
      { h: "1. Procedure" },
      { p: "The complaint of 30 July 2025 was registered on 4 August 2025 under reference R/123/25." },
      { h: "2. Assessment" },
      {
        p: "The Appointing Authority has examined the medical report of 15 June 2025 (Annex 2). It considers that the report does not establish that the conduct complained of caused the symptoms described.",
      },
      {
        p: "As regards the email of the Internal Audit Service of 2 October 2024 (Annex 3), the Appointing Authority notes that the audit concerned the design of the procurement workflow.",
      },
      "pagebreak",
      { p: "The Administration does not contend that the audit report attributes the findings to the complainant personally." },
      { p: "The complainant also refers to her performance appraisal for 2023 (Annex 4)." },
      { h: "3. Conclusion" },
      { p: "The complaint is rejected." },
      { p: "For the Appointing Authority, Paul Martin" },
    ],
    "Reply to complaint R/123/25",
  );
  write("article90/2025-11-28_reply_to_complaint_article90.pdf", reply90, "Reply rejecting the complaint (2 pages); silent on Annex 1, only mentions Annex 4");

  // ----- Administrative inquiry ----------------------------------------------------------------
  write(
    "investigation/2025-03-03_decision_opening_inquiry.docx",
    await makeDocx({
      title: "Decision opening an administrative inquiry",
      creator: "Investigation unit",
      blocks: [
        { h: "Decision opening an administrative inquiry" },
        { p: "Brussels, 3 March 2025" },
        { p: "An administrative inquiry is opened into the allegations made by Ms Jane Doe in her request for assistance of 17 January 2025. The inquiry is entrusted to the Investigation Unit, which shall report within six weeks." },
      ],
    }),
    "Decision opening the inquiry (DOCX)",
  );
  write(
    "investigation/2025-04-14_administrative_inquiry_report.pdf",
    await makePdf(
      [
        { h: "ADMINISTRATIVE INQUIRY REPORT", size: 15 },
        { p: "Investigation Unit\nFinal report, 14 April 2025" },
        { h: "1. Conduct of the inquiry" },
        { p: "The inquiry was opened on 3 March 2025. Ms Maria Rossi was interviewed on 20 March 2025. Mr Victor Hale was interviewed on 24 March 2025." },
        "pagebreak",
        { h: "2. Findings" },
        { p: "Ms Rossi confirmed that Mr Hale raised his voice at Ms Doe during the meeting of 26 November 2024. Mr Hale stated that he had only criticised the handling of procurement files." },
        { p: "The inquiry found that the incident of 26 November 2024 took place but did not establish a repeated pattern of conduct." },
        "pagebreak",
        { h: "3. Recommendations" },
        { p: "It is recommended that managers in Unit C.3 attend training on respectful communication." },
      ],
      "Administrative inquiry report",
    ),
    "Investigation report (3 pages)",
  );

  // ----- Court proceedings ---------------------------------------------------------------------
  write(
    "court/2026-02-20_application_general_court.pdf",
    await makePdf(
      [
        { h: "APPLICATION TO THE GENERAL COURT", size: 15 },
        { p: "Case T-123/26, Doe v Example Agency\nLodged on 20 February 2026" },
        { h: "Form of order sought" },
        { p: "The applicant claims that the Court should annul the decision of 12 May 2025 and the reply to complaint R/123/25 of 28 November 2025, and order the Agency to pay damages." },
        "pagebreak",
        { h: "Pleas in law" },
        {
          p: "First plea: failure to examine the witness statement of Ms Maria Rossi (Annex A.5). Second plea: manifest error of assessment of the inquiry report of 14 April 2025 (Annex A.6). Third plea: breach of the duty to state reasons.",
        },
        { h: "Annexes" },
        { p: "Annex A.5: witness statement of Ms Maria Rossi dated 10 January 2025.\nAnnex A.6: administrative inquiry report of 14 April 2025." },
      ],
      "Application T-123/26",
    ),
    "Court application (2 pages) raising Annexes A.5 and A.6",
  );
  write(
    "court/2026-05-15_defence_example_agency.docx",
    await makeDocx({
      title: "Defence - Case T-123/26",
      creator: "Agent of the Agency",
      blocks: [
        { h: "Defence of Example Agency, Case T-123/26" },
        { p: "Luxembourg, 15 May 2026" },
        { h: "On the second plea", level: 2 },
        { p: "The inquiry report of 14 April 2025 (Annex A.6) found that no repeated pattern of conduct was established. The Agency considers that the Appointing Authority correctly relied on that report." },
        { h: "On the audit report", level: 2 },
        { p: "The Agency contends that the audit report identified shortcomings in the procurement files handled by the applicant." },
        { p: "For the Agency, its agents" },
      ],
    }),
    "Defence (DOCX): position on the audit report changes again; silent on Annex A.5",
  );
  write(
    "court/registry_receipt_scanned.pdf",
    await makeScannedPdf([
      { h: "GENERAL COURT - REGISTRY", size: 16 },
      { p: "Receipt of a procedural document", size: 13 },
      { p: "Case T-123/26. The application was received at the Registry on 20 February 2026.", size: 13 },
    ]),
    "Scanned registry receipt",
  );

  // ----- More emails and audit material ---------------------------------------------------------
  write(
    "emails/2024-12-03_email_from_hale_annex_c.eml",
    makeEml({
      from: '"Victor Hale" <victor.hale@agency.example.org>',
      to: `"${JANE.name}" <${JANE.address}>`,
      subject: "Procurement files",
      date: "Tue, 3 Dec 2024 18:47:00 +0100",
      messageId: "<20241203184700.vh01@agency.example.org>",
      body: "Jane,\r\n\r\nYou are personally responsible for the procurement irregularities identified by the Internal Audit Service. I expect a full explanation by Friday.\r\n\r\nVictor",
    }),
    "The 'Annex C' email itself (.eml)",
  );
  write(
    "emails/2025-03-10_invitation_to_interview.msg",
    buildMsg({
      subject: "Administrative inquiry - invitation to interview",
      from: { name: "Investigation Unit", address: "investigations@agency.example.org" },
      to: [{ name: "Maria Rossi", address: "maria.rossi@agency.example.org" }],
      sentAt: new Date("2025-03-10T09:00:00Z"),
      utcOffsetMinutes: 60,
      messageId: "<20250310090000.iu01@agency.example.org>",
      body: "Dear Ms Rossi,\r\n\r\nIn the context of the administrative inquiry opened on 3 March 2025, you are invited to an interview on 20 March 2025 at 10:00.\r\n\r\nInvestigation Unit",
    }),
    "Outlook .msg invitation to interview",
  );
  write(
    "emails/2025-06-02_request_for_access_to_file.eml",
    makeEml({
      from: `"${COUNSEL.name}" <${COUNSEL.address}>`,
      to: `"${HR.name}" <${HR.address}>`,
      subject: "Request for access to the personal file - Ms Doe",
      date: "Mon, 2 Jun 2025 15:05:00 +0200",
      messageId: "<20250602150500.al02@lawfirm.example.org>",
      body: "Dear colleagues,\r\n\r\nOn behalf of my client, I request access to the complete file of the administrative inquiry, including the interview records of 20 and 24 March 2025.\r\n\r\nAnne Leroy",
    }),
    "Lawyer email (.eml) requesting access to the file",
  );
  write(
    "emails/2025-12-01_fwd_reply_to_complaint.msg",
    buildMsg({
      subject: "FW: Reply to complaint R/123/25",
      from: HR,
      to: [COUNSEL],
      sentAt: new Date("2025-12-01T08:15:00Z"),
      utcOffsetMinutes: 60,
      messageId: "<20251201081500.hr04@agency.example.org>",
      body: "Dear Maître Leroy,\r\n\r\nPlease find attached the reply to the complaint R/123/25 of your client.\r\n\r\nHR Unit B.2",
      attachments: [{ filename: "Reply_R-123-25.pdf", mimeType: "application/pdf", data: reply90 }],
    }),
    "Outlook .msg forwarding the reply (attachment duplicates the reply PDF)",
  );
  write(
    "audit/2025-01-15_IAS_follow_up_memo.docx",
    await makeDocx({
      title: "IAS follow-up memo",
      creator: "Internal Audit Service",
      blocks: [
        { h: "Follow-up of audit IAS-2024-07" },
        { p: "Date: 15 January 2025" },
        { p: "Both recommendations of audit IAS-2024-07 have been implemented: segregation of duties is now enforced and approval thresholds are configured. The follow-up did not identify any individual responsibility." },
      ],
    }),
    "IAS follow-up memo (DOCX)",
  );

  write("misc/agency_logo.png", Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")), "Unsupported format (image) - registered with hash only");

  return files;
}
