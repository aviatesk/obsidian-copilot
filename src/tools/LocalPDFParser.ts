import { TFile, Vault } from "obsidian";
import { getDocument } from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.mjs";

export class LocalPDFParser {
  async parseFile(file: TFile, vault: Vault): Promise<string> {
    try {
      const pdfData = await vault.readBinary(file);
      const loadingTask = getDocument({
        data: pdfData,
        disableFontFace: true,
      });

      const pdf = await loadingTask.promise;
      let fullText = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const items = textContent.items as Array<{
          str: string;
          transform: number[];
          width: number;
        }>;
        const lines: { text: string; y: number }[] = [];

        items.forEach((item) => {
          const y = item.transform[5];
          const existingLine = lines.find((line) => Math.abs(line.y - y) < 5);

          if (existingLine) {
            existingLine.text += " " + item.str;
          } else {
            lines.push({ text: item.str, y });
          }
        });

        lines.sort((a, b) => b.y - a.y);
        const pageText = lines.map((line) => line.text.trim()).join("\n");
        fullText += pageText + "\n\n";
      }

      return fullText.trim();
    } catch {
      return `[Error: Could not extract content from PDF ${file.basename}]`;
    }
  }
}
