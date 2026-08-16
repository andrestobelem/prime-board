/**
 * Question Tool - Single question with options
 * Uses Prime Agent's select and input dialogs so it works in interactive and daemon modes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
  label: string;
  description?: string;
}

interface QuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom?: boolean;
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
});

const QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
    parameters: QuestionParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const simpleOptions = params.options.map((o) => o.label);
      const cancelledResult = () => ({
        content: [{ type: "text" as const, text: "User cancelled the selection" }],
        details: {
          question: params.question,
          options: simpleOptions,
          answer: null,
        } as QuestionDetails,
      });

      if (!ctx.hasUI) {
        return {
          content: [
            { type: "text", text: "Error: UI not available (running in non-interactive mode)" },
          ],
          details: {
            question: params.question,
            options: simpleOptions,
            answer: null,
          } as QuestionDetails,
        };
      }

      if (params.options.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No options provided" }],
          details: { question: params.question, options: [], answer: null } as QuestionDetails,
        };
      }

      const customOption = "Type something.";
      const selected = await ctx.ui.select(params.question, [...simpleOptions, customOption]);
      if (!selected) {
        return cancelledResult();
      }

      if (selected === customOption) {
        const customAnswer = await ctx.ui.input("Your answer", "Type something.");
        const answer = customAnswer?.trim();
        if (!answer) {
          return cancelledResult();
        }

        return {
          content: [{ type: "text", text: `User wrote: ${answer}` }],
          details: {
            question: params.question,
            options: simpleOptions,
            answer,
            wasCustom: true,
          } as QuestionDetails,
        };
      }

      const index = simpleOptions.indexOf(selected);
      return {
        content: [{ type: "text", text: `User selected: ${index + 1}. ${selected}` }],
        details: {
          question: params.question,
          options: simpleOptions,
          answer: selected,
          wasCustom: false,
        } as QuestionDetails,
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
      const opts = Array.isArray(args.options) ? args.options : [];
      if (opts.length) {
        const labels = opts.map((o: OptionWithDesc) => o.label);
        const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
        text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.answer === null) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }
      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
    },
  });
}
