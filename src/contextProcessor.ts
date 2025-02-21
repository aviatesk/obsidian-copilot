import { ChainType } from "@/chainFactory";
import { CustomPromptProcessor } from "@/customPromptProcessor";
import { FileParserManager } from "@/tools/FileParserManager";
import { TFile, Vault } from "obsidian";
import { GeminiMessagePart } from "@/LLMProviders/chainManager";

interface PDFProcessingResult {
  content: string;
  pdfParts?: GeminiMessagePart[];
}

export class ContextProcessor {
  private static instance: ContextProcessor;

  private constructor() {}

  static getInstance(): ContextProcessor {
    if (!ContextProcessor.instance) {
      ContextProcessor.instance = new ContextProcessor();
    }
    return ContextProcessor.instance;
  }

  async processEmbeddedPDFs(
    content: string,
    vault: Vault,
    fileParserManager: FileParserManager,
    isGeminiModel: boolean = false
  ): Promise<PDFProcessingResult> {
    // Match both ![[file.pdf]] and [[file.pdf]] patterns
    const pdfRegex = /!?\[\[(.*?\.pdf)\]\]/g;
    const matches = [...content.matchAll(pdfRegex)];
    const pdfParts: PDFProcessingResult["pdfParts"] = [];

    for (const match of matches) {
      const pdfName = match[1];
      const pdfFile = vault.getAbstractFileByPath(pdfName);

      if (pdfFile instanceof TFile) {
        try {
          if (isGeminiModel) {
            // For Gemini models, we'll collect PDF parts to be sent directly to the model
            const pdfData = await vault.readBinary(pdfFile);
            pdfParts.push({
              inlineData: {
                data: Buffer.from(pdfData).toString("base64"),
                mimeType: "application/pdf",
              },
            });
            // Replace the PDF reference with a simple marker
            content = content.replace(match[0], `\n\n[PDF: ${pdfName}]\n\n`);
          } else {
            // For non-Gemini models, use the traditional parser approach
            const pdfContent = await fileParserManager.parseFile(pdfFile, vault);
            content = content.replace(
              match[0],
              `\n\nEmbedded PDF (${pdfName}):\n${pdfContent}\n\n`
            );
          }
        } catch (error) {
          console.error(`Error processing embedded PDF ${pdfName}:`, error);
          content = content.replace(
            match[0],
            `\n\nEmbedded PDF (${pdfName}): [Error: Could not process PDF]\n\n`
          );
        }
      } else {
        console.warn("PDF file not found:", {
          pdfName,
          availableFiles: vault.getFiles().map((f) => f.path),
        });
      }
    }

    return isGeminiModel ? { content, pdfParts } : { content };
  }

  async processContextNotes(
    customPromptProcessor: CustomPromptProcessor,
    fileParserManager: FileParserManager,
    vault: Vault,
    contextNotes: TFile[],
    includeActiveNote: boolean,
    activeNote: TFile | null,
    currentChain: ChainType
  ): Promise<string> {
    const processedVars = await customPromptProcessor.getProcessedVariables();
    let additionalContext = "";

    const processNote = async (note: TFile) => {
      try {
        // Skip if this note was already processed by processCustomPrompt
        const noteRef = `[[${note.basename}]]`;
        if (processedVars.has(noteRef)) {
          return;
        }

        if (!fileParserManager.supportsExtension(note.extension)) {
          console.warn(`Unsupported file type: ${note.extension}`);
          return;
        }

        let content = await fileParserManager.parseFile(note, vault);

        if (note.extension === "md") {
          const result = await this.processEmbeddedPDFs(content, vault, fileParserManager);
          content = result.content;
        }

        additionalContext += `\n\nTitle: [[${note.basename}]]\nPath: ${note.path}\n\n${content}`;
      } catch (error) {
        console.error(`Error processing file ${note.path}:`, error);
        additionalContext += `\n\nTitle: [[${note.basename}]]\nPath: ${note.path}\n\n[Error: Could not process file]`;
      }
    };

    // Process active note if included
    if (includeActiveNote && activeNote) {
      const activeNoteVar = `activeNote`;
      const activeNotePath = `[[${activeNote.basename}]]`;
      if (!processedVars.has(activeNoteVar) && !processedVars.has(activeNotePath)) {
        await processNote(activeNote);
      }
    }

    // Process context notes
    for (const note of contextNotes) {
      await processNote(note);
    }

    return additionalContext;
  }

  async hasEmbeddedPDFs(content: string): Promise<boolean> {
    const pdfRegex = /!?\[\[(.*?\.pdf)\]\]/g;
    return pdfRegex.test(content);
  }

  async addNoteToContext(
    note: TFile,
    vault: Vault,
    contextNotes: TFile[],
    activeNote: TFile | null,
    setContextNotes: (notes: TFile[] | ((prev: TFile[]) => TFile[])) => void,
    setIncludeActiveNote: (include: boolean) => void
  ): Promise<void> {
    // Only check if the note exists in contextNotes
    if (contextNotes.some((existing) => existing.path === note.path)) {
      return; // Note already exists in context
    }

    // Read the note content
    const content = await vault.read(note);
    const hasEmbeddedPDFs = await this.hasEmbeddedPDFs(content);

    // Set includeActiveNote if it's the active note
    if (activeNote && note.path === activeNote.path) {
      setIncludeActiveNote(true);
    }

    // Add to contextNotes with wasAddedViaReference flag
    setContextNotes((prev: TFile[]) => [
      ...prev,
      Object.assign(note, {
        wasAddedViaReference: true,
        hasEmbeddedPDFs,
      }),
    ]);
  }
}
