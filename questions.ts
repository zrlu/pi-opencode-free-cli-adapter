export async function answerQuestions(ui: any, request: any, signal: AbortSignal): Promise<string[][] | undefined> {
  const answers: string[][] = [];
  for (const question of request.questions) {
    const selected: string[] = [];
    const title = `${question.header}: ${question.question}`;
    const custom = "✎ Custom answer";
    const done = "✓ Done";
    while (true) {
      signal.throwIfAborted();
      const options = (question.options ?? []).filter((option: any) => !selected.includes(option.label));
      const labels = options.map((option: any) => option.description ? `${option.label} — ${option.description}` : option.label);
      const choices = [...labels, ...(question.custom !== false ? [custom] : []), ...(question.multiple && selected.length ? [done] : [])];
      const choice = await ui.select(title, choices, { signal });
      signal.throwIfAborted();
      if (choice === undefined) return undefined;
      if (choice === done) break;
      if (choice === custom) {
        const value = await ui.input(title, "Enter answer", { signal });
        signal.throwIfAborted();
        if (value === undefined) return undefined;
        if (!value.trim()) continue;
        selected.push(value);
      } else {
        const index = labels.indexOf(choice);
        if (index < 0) continue;
        selected.push(options[index].label);
      }
      if (!question.multiple) break;
    }
    answers.push(selected);
  }
  return answers;
}
