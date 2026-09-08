import * as vscode from 'vscode';
import { FilterMode, WalkthroughProvider } from './WalkthroughProvider';

export function activate(context: vscode.ExtensionContext) {
    let currentStep = 0;
    let rawSymbols: vscode.DocumentSymbol[] = [];
    let codeBlocks: Array<{ range: vscode.Range; name: string; kind: vscode.SymbolKind }> = [];
    let filterMode: FilterMode = 'deep';

    let mainCancellationToken: vscode.CancellationTokenSource | undefined;
    let followUpCancellationToken: vscode.CancellationTokenSource | undefined;

    let lastGeneratedExplanation = '';

    const highlightDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(0, 122, 255, 0.07)',
        border: '1px dashed rgba(0, 122, 255, 0.35)',
        isWholeLine: true,
    });

    const uiProvider = new WalkthroughProvider(context.extensionUri);
    context.subscriptions.push({ dispose: () => uiProvider.dispose() });
    context.subscriptions.push(highlightDecorationType);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(WalkthroughProvider.viewType, uiProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    const rebuildFilteredBlocks = () => {
        if (rawSymbols.length === 0) {
            return;
        }

        if (filterMode === 'macro') {
            const macroKinds = [
                vscode.SymbolKind.Class,
                vscode.SymbolKind.Interface,
                vscode.SymbolKind.Method,
                vscode.SymbolKind.Function,
                vscode.SymbolKind.Constructor,
            ];
            codeBlocks = rawSymbols
                .filter((sym) => macroKinds.includes(sym.kind))
                .map((sym) => ({ range: sym.range, name: sym.name, kind: sym.kind }));
        } else {
            codeBlocks = rawSymbols.map((sym) => ({
                range: sym.range,
                name: sym.name,
                kind: sym.kind,
            }));
        }

        if (currentStep >= codeBlocks.length) {
            currentStep = Math.max(0, codeBlocks.length - 1);
        }
    };

    const requireEditor = (): vscode.TextEditor => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showErrorMessage(
                'Lumen: No active editor. Open a file, then run Illuminate again.'
            );
            throw new Error('Lumen: no active editor');
        }
        return editor;
    };

    const requireActiveWalkthrough = (): void => {
        if (codeBlocks.length === 0) {
            void vscode.window.showErrorMessage(
                'Lumen: No active walkthrough. Run "Lumen: Illuminate Active File" first.'
            );
            throw new Error('Lumen: no active walkthrough');
        }
    };

    const streamBlockExplanation = async (editor: vscode.TextEditor, stepIndex: number) => {
        if (mainCancellationToken) {
            mainCancellationToken.cancel();
            mainCancellationToken.dispose();
        }
        mainCancellationToken = new vscode.CancellationTokenSource();

        if (codeBlocks.length === 0 || stepIndex >= codeBlocks.length) {
            void vscode.window.showErrorMessage('Lumen: No code blocks available to illuminate.');
            throw new Error('Lumen: empty walkthrough');
        }

        const activeBlock = codeBlocks[stepIndex];

        editor.setDecorations(highlightDecorationType, [activeBlock.range]);
        editor.revealRange(activeBlock.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

        await uiProvider.openOnBlock(
            editor,
            activeBlock.range,
            stepIndex + 1,
            codeBlocks.length,
            filterMode
        );
        lastGeneratedExplanation = '';

        try {
            let models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });

            if (!models || models.length === 0) {
                const fallbackModels = await vscode.lm.selectChatModels({});
                if (fallbackModels && fallbackModels.length > 0) {
                    models = fallbackModels;
                }
            }

            const codeSnippet = editor.document.getText(activeBlock.range);

            if (!models || models.length === 0) {
                uiProvider.appendExplanationToken(
                    `[Lumen Sandbox Mode: Cursor Account Token Missing in Debugger Host]\n\n`
                );

                const mockResponseTokens = [
                    `This block defines the primary execution logic for ${activeBlock.name}. `,
                    `It takes raw incoming context parameters and processes them safely. `,
                    `The system maps these bounds dynamically to ensure reliable cross-functional runtime execution.`,
                ];

                for (const phrase of mockResponseTokens) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    lastGeneratedExplanation += phrase;
                    uiProvider.appendExplanationToken(phrase);
                }
                return;
            }

            const model = models[0];

            const messages = [
                vscode.LanguageModelChatMessage.User(
                    'You are an elite developer onboarding guide. Summarise the explicit engineering impact of the code block in 3 sentences max without markdown blocks.'
                ),
                vscode.LanguageModelChatMessage.User(
                    `Explain this specific block (${activeBlock.name}):\n\n${codeSnippet}`
                ),
            ];

            const response = await model.sendRequest(messages, {}, mainCancellationToken.token);

            for await (const chunk of response.text) {
                lastGeneratedExplanation += chunk;
                uiProvider.appendExplanationToken(chunk);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.message.startsWith('Lumen:')) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            uiProvider.showError(message);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('walkthrough.askFollowUp', async (userQuestion: string) => {
            if (followUpCancellationToken) {
                followUpCancellationToken.cancel();
                followUpCancellationToken.dispose();
            }
            followUpCancellationToken = new vscode.CancellationTokenSource();

            try {
                requireActiveWalkthrough();
                const editor = requireEditor();
                const currentBlock = codeBlocks[currentStep];
                const blockCode = editor.document.getText(currentBlock.range);

                uiProvider.beginFollowup();

                let models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
                if (!models || models.length === 0) {
                    const fallbackModels = await vscode.lm.selectChatModels({});
                    if (fallbackModels && fallbackModels.length > 0) {
                        models = fallbackModels;
                    }
                }

                if (!models || models.length === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    uiProvider.appendFollowupToken(
                        `Lumen Sandbox Mode: Received your question ("${userQuestion}"). To test live AI integration, package the extension into a .vsix and load it into your main logged-in Cursor instance!`
                    );
                    return;
                }

                const model = models[0];

                const contextSystemPrompt = `You are discussing a highlighted block of code named "${currentBlock.name}". \nCode Snippet Context:\n${blockCode}\n\nYour previous analysis summary:\n${lastGeneratedExplanation}`;
                const messages = [
                    vscode.LanguageModelChatMessage.User(contextSystemPrompt),
                    vscode.LanguageModelChatMessage.User(
                        `The user asks this follow-up query: ${userQuestion}`
                    ),
                ];

                const response = await model.sendRequest(
                    messages,
                    {},
                    followUpCancellationToken.token
                );
                for await (const chunk of response.text) {
                    uiProvider.appendFollowupToken(chunk);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.message.startsWith('Lumen:')) {
                    return;
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('walkthrough.setFilter', async (mode: FilterMode) => {
            if (mode !== 'deep' && mode !== 'macro') {
                void vscode.window.showErrorMessage(`Lumen: Unknown filter mode "${String(mode)}".`);
                return;
            }
            filterMode = mode;
            uiProvider.setFilterMode(mode);
            rebuildFilteredBlocks();
            try {
                const editor = requireEditor();
                if (codeBlocks.length === 0) {
                    void vscode.window.showErrorMessage(
                        'Lumen: No blocks match this filter. Try Deep Scan or illuminate the file again.'
                    );
                    return;
                }
                await streamBlockExplanation(editor, currentStep);
            } catch {
                // Loud failures already toasted
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('walkthrough.start', async () => {
            try {
                const editor = requireEditor();

                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    editor.document.uri
                );

                if (symbols && symbols.length > 0) {
                    rawSymbols = symbols.sort(
                        (a, b) => a.range.start.line - b.range.start.line
                    );
                    rebuildFilteredBlocks();
                } else {
                    const lineCount = editor.document.lineCount;
                    codeBlocks = [];
                    for (let i = 0; i < lineCount; i += 15) {
                        const end = Math.min(i + 14, lineCount - 1);
                        codeBlocks.push({
                            range: new vscode.Range(i, 0, end, 0),
                            name: `Lines ${i + 1}-${end + 1}`,
                            kind: vscode.SymbolKind.Namespace,
                        });
                    }
                }

                if (codeBlocks.length === 0) {
                    void vscode.window.showErrorMessage(
                        'Lumen: Could not find any illuminable blocks in this file.'
                    );
                    return;
                }

                currentStep = 0;
                await streamBlockExplanation(editor, currentStep);
            } catch {
                // Loud failures already toasted
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('walkthrough.next', async () => {
            try {
                requireActiveWalkthrough();
                const editor = requireEditor();
                if (currentStep >= codeBlocks.length - 1) {
                    void vscode.window.showErrorMessage('Lumen: Already on the last block.');
                    return;
                }
                currentStep++;
                await streamBlockExplanation(editor, currentStep);
            } catch {
                // Loud failures already toasted
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('walkthrough.prev', async () => {
            try {
                requireActiveWalkthrough();
                const editor = requireEditor();
                if (currentStep <= 0) {
                    void vscode.window.showErrorMessage('Lumen: Already on the first block.');
                    return;
                }
                currentStep--;
                await streamBlockExplanation(editor, currentStep);
            } catch {
                // Loud failures already toasted
            }
        })
    );
}

export function deactivate() {}
