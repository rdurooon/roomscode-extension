import * as path from 'path';

import * as diffMatchPatch from 'diff-match-patch';
import { io, Socket } from 'socket.io-client';
import * as vscode from 'vscode';

let socket: Socket | undefined;
let roomCode: string | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let cursorDebounceTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

// Latência medida via ping_probe/pong_probe (app-level), exibida no tooltip da barra de status.
let lastLatencyMs: number | undefined;
let latencyProbeInterval: NodeJS.Timeout | undefined;
const LATENCY_PROBE_INTERVAL_MS = 15000;

const LATENCY_STATUS_LABEL = (ms: number | undefined) => {
    if (ms === undefined) {
        return '';
    }
    if (ms < 150) return ` (${ms}ms — ótima)`;
    if (ms < 400) return ` (${ms}ms — ok)`;
    return ` (${ms}ms — lenta)`;
};

// Servidor oficial, usado pelo fluxo padrão; outro servidor só via comando "Conectar a um servidor personalizado".
const DEFAULT_SERVER_URL = 'https://roomscode.com';

// Tempo máximo de espera pela confirmação de autenticação (attached/attach_error) após o socket conectar.
const ATTACH_TIMEOUT_MS = 15000;

// Último conteúdo enviado de cada aba (chave = uri), usado para calcular o diff.
const lastSentContentByTab = new Map<string, string>();

const DEBOUNCE_MS = 150;
const CURSOR_DEBOUNCE_MS = 100;
const dmp = new diffMatchPatch.diff_match_patch();

interface OpenTab {
    tabId: string;
    filename: string;
    language: string;
    content: string;
    path: string;
}

// Árvore do workspace (botão "Diretório" do espectador): só nomes, nunca conteúdo.
interface TreeNode {
    name: string;
    type: 'dir' | 'file';
    blocked?: boolean;
    children?: TreeNode[];
}

// Pastas que aparecem na árvore, mas sem listar o que há dentro (pesadas ou geradas).
const BLOCKED_FOLDER_NAMES = new Set([
    'node_modules',
    '.venv',
    'venv',
    '.git',
    '__pycache__',
    '.mypy_cache',
    '.pytest_cache',
    '.tox',
    '.next',
    '.nuxt',
]);
const MAX_TREE_NODES = 4000; // mesmo teto padrão do servidor (MAX_TREE_NODES)
const MAX_TREE_DEPTH = 20;
const TREE_DEBOUNCE_MS = 800;
let treeDebounceTimer: NodeJS.Timeout | undefined;
let treeBuildSeq = 0;

export function activate(context: vscode.ExtensionContext) {
    // Botão na barra de status; texto e ação mudam conforme o estado de conexão. Usa $(vm-connect) (único ícone codicon aplicável).
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBarItem);
    updateStatusBarItem();
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('roomscode.attach', attachToRoom),
        vscode.commands.registerCommand('roomscode.attachCustomServer', attachToCustomServerRoom),
        vscode.commands.registerCommand('roomscode.detach', detachFromRoom),
        vscode.window.tabGroups.onDidChangeTabs(() => sendTabsList()),
        // Cobre o caso de uma aba nova cujo documento ainda não terminou de carregar quando tabGroups dispara.
        vscode.workspace.onDidOpenTextDocument(() => sendTabsList()),
        vscode.window.onDidChangeActiveTextEditor(handleActiveEditorChange),
        vscode.window.onDidChangeTextEditorSelection(handleSelectionChange),
        vscode.workspace.onDidChangeTextDocument(handleDocumentChange),
        vscode.workspace.onDidSaveTextDocument(handleDocumentSave),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            sendTabsList();
            scheduleWorkspaceTreeSend();
        })
    );

    // Só criação/remoção (inclui renomear/mover) muda a árvore; edições de conteúdo são ignoradas.
    const treeWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    treeWatcher.onDidCreate((uri) => handleTreeFsEvent(uri));
    treeWatcher.onDidDelete((uri) => handleTreeFsEvent(uri));
    context.subscriptions.push(treeWatcher);
}

export function deactivate() {
    if (treeDebounceTimer) {
        clearTimeout(treeDebounceTimer);
    }
    socket?.disconnect();
}

/** Fluxo padrão (barra de status / "Conectar a uma sala"): sempre usa o servidor oficial. */
async function attachToRoom() {
    await connectToServer(DEFAULT_SERVER_URL);
}

/** Fluxo alternativo (Command Palette): pergunta o endereço do servidor, para desenvolvimento local ou instâncias próprias. */
async function attachToCustomServerRoom() {
    const serverUrl = await vscode.window.showInputBox({
        prompt: 'Endereço do servidor RoomsCode (uso avançado/desenvolvimento)',
        value: 'http://localhost:5000',
    });
    if (!serverUrl) {
        return;
    }
    await connectToServer(serverUrl);
}

/** Conecta ao servidor informado usando o token da extensão, que sozinho já identifica a sala no backend. */
async function connectToServer(serverUrl: string) {
    const extToken = await vscode.window.showInputBox({
        prompt: 'Código da extensão (botão "Copiar código da extensão" na tela do Host)',
        password: true,
    });
    if (!extToken) {
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'RoomsCode',
            cancellable: true,
        },
        (progress, cancellationToken) =>
            new Promise<void>((resolve) => {
                const startedAt = Date.now();
                let settled = false;
                let elapsedTimer: NodeJS.Timeout | undefined;
                let attachTimeoutTimer: NodeJS.Timeout | undefined;

                const finish = () => {
                    if (settled) return;
                    settled = true;
                    if (elapsedTimer) clearInterval(elapsedTimer);
                    if (attachTimeoutTimer) clearTimeout(attachTimeoutTimer);
                    resolve();
                };

                cancellationToken.onCancellationRequested(() => {
                    vscode.window.showInformationMessage('RoomsCode: conexão cancelada.');
                    socket?.disconnect();
                    socket = undefined;
                    roomCode = undefined;
                    updateStatusBarItem();
                    finish();
                });

                progress.report({ message: 'Conectando ao servidor...' });

                // Mostra o tempo decorrido enquanto conecta, para dar feedback em redes lentas.
                elapsedTimer = setInterval(() => {
                    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
                    const stage = socket?.connected ? 'Autenticando na sala...' : 'Conectando ao servidor...';
                    progress.report({ message: `${stage} (${elapsedSeconds}s)` });
                }, 1000);

                // Tenta WebSocket direto (sem o handshake extra de long-polling), com polling como fallback.
                socket = io(serverUrl, {
                    transports: ['websocket', 'polling'],
                    timeout: 10000,
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 5000,
                });

                socket.on('connect', () => {
                    progress.report({ message: 'Autenticando na sala...' });
                    socket?.emit('extension_attach', { ext_token: extToken });

                    if (attachTimeoutTimer) clearTimeout(attachTimeoutTimer);
                    attachTimeoutTimer = setTimeout(() => {
                        vscode.window.showWarningMessage(
                            'RoomsCode: o servidor demorou demais pra confirmar a autenticação. Verifique o código da extensão e tente de novo.'
                        );
                        socket?.disconnect();
                        socket = undefined;
                        roomCode = undefined;
                        updateStatusBarItem();
                        finish();
                    }, ATTACH_TIMEOUT_MS);
                });

                socket.on('attached', (data: { code: string }) => {
                    if (attachTimeoutTimer) clearTimeout(attachTimeoutTimer);
                    roomCode = data.code;
                    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
                    vscode.window.showInformationMessage(
                        `RoomsCode: conectado à sala ${roomCode} (${elapsedSeconds}s).`
                    );
                    updateStatusBarItem();
                    startLatencyProbing();
                    sendTabsList();
                    sendWorkspaceTree();
                    sendCursorLine(vscode.window.activeTextEditor);
                    finish();
                });

                socket.on('attach_error', (data: { message: string }) => {
                    if (attachTimeoutTimer) clearTimeout(attachTimeoutTimer);
                    vscode.window.showErrorMessage(`RoomsCode: ${data.message}`);
                    updateStatusBarItem();
                    socket?.disconnect();
                    socket = undefined;
                    roomCode = undefined;
                    finish();
                });

                socket.on('connect_error', (err: Error) => {
                    progress.report({ message: `Falha ao conectar: ${err.message}. Tentando de novo...` });
                });

                // Reautentica sozinha em reconexões automáticas do socket.io, sem pedir o token de novo.
                socket.io.on('reconnect_attempt', () => {
                    vscode.window.setStatusBarMessage('RoomsCode: reconectando...', 4000);
                });
                socket.io.on('reconnect_failed', () => {
                    vscode.window.showWarningMessage(
                        'RoomsCode: não foi possível restabelecer a conexão automaticamente. Tente conectar de novo.'
                    );
                });

                socket.on('request_full_resync', () => {
                    // Backend perdeu a sincronia de alguma aba; reenviar o estado completo resolve.
                    sendTabsList();
                });

                socket.on('pong_probe', (data: { client_sent_at: number }) => {
                    if (typeof data?.client_sent_at === 'number') {
                        lastLatencyMs = Date.now() - data.client_sent_at;
                        updateStatusBarItem();
                    }
                });

                socket.on('disconnect', () => {
                    vscode.window.showWarningMessage('RoomsCode: desconectado do servidor.');
                    roomCode = undefined;
                    lastLatencyMs = undefined;
                    stopLatencyProbing();
                    updateStatusBarItem();
                    finish(); // libera a notificação de progresso caso a queda ocorra antes de autenticar
                });

                updateStatusBarItem();
            })
    );
}

function startLatencyProbing() {
    stopLatencyProbing();
    const probe = () => {
        if (socket && socket.connected) {
            socket.emit('ping_probe', { client_sent_at: Date.now() });
        }
    };
    probe(); // primeira medição imediata
    latencyProbeInterval = setInterval(probe, LATENCY_PROBE_INTERVAL_MS);
}

function stopLatencyProbing() {
    if (latencyProbeInterval) {
        clearInterval(latencyProbeInterval);
        latencyProbeInterval = undefined;
    }
}

function detachFromRoom() {
    socket?.disconnect();
    socket = undefined;
    roomCode = undefined;
    lastLatencyMs = undefined;
    stopLatencyProbing();
    lastSentContentByTab.clear();
    if (treeDebounceTimer) {
        clearTimeout(treeDebounceTimer);
        treeDebounceTimer = undefined;
    }
    vscode.window.showInformationMessage('RoomsCode: desconectado da sala.');
    updateStatusBarItem();
}

/** Mantém o texto/comando da barra de status de acordo com o estado atual. */
function updateStatusBarItem() {
    if (!statusBarItem) {
        return;
    }

    if (socket && socket.connected && roomCode) {
        statusBarItem.text = '$(vm-connect) Desconectar-se da sala';
        statusBarItem.tooltip = `RoomsCode: conectado à sala ${roomCode}${LATENCY_STATUS_LABEL(lastLatencyMs)}. Clique para desconectar.`;
        statusBarItem.command = 'roomscode.detach';
    } else if (socket && !socket.connected) {
        statusBarItem.text = '$(sync~spin) RoomsCode: reconectando...';
        statusBarItem.tooltip = 'RoomsCode: conexão perdida, tentando reconectar automaticamente.';
        statusBarItem.command = 'roomscode.detach';
    } else {
        statusBarItem.text = '$(vm-connect) Conectar-se a uma sala';
        statusBarItem.tooltip = 'RoomsCode: clique para conectar seu VS Code a uma sala.';
        statusBarItem.command = 'roomscode.attach';
    }
}

function tabIdFor(document: vscode.TextDocument): string {
    return document.uri.toString();
}

/** Uma aba só é compartilhada se pertencer a um workspace folder aberto, evitando vazar arquivos "de fora". */
function isWithinOpenWorkspace(uri: vscode.Uri): boolean {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/**
 * Caminho do arquivo dentro do workspace, no formato "<pasta raiz>/<subpastas>/<arquivo>" (sempre com "/").
 * É a chave que liga a aba aberta ao arquivo da árvore do diretório; nunca inclui o caminho absoluto.
 */
function workspacePathFor(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return '';
    }
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    return relative ? `${folder.name}/${relative}` : folder.name;
}

async function collectOpenTabs(): Promise<OpenTab[]> {
    const docsByUri = new Map<string, vscode.TextDocument>();
    for (const doc of vscode.workspace.textDocuments) {
        docsByUri.set(doc.uri.toString(), doc);
    }

    const tabs: OpenTab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (!(input instanceof vscode.TabInputText)) {
                continue;
            }
            if (!isWithinOpenWorkspace(input.uri)) {
                continue;
            }

            const uriString = input.uri.toString();
            let doc = docsByUri.get(uriString);

            if (!doc) {
                // Aba restaurada de sessão anterior, ainda sem documento carregado em memória; força o carregamento.
                try {
                    doc = await vscode.workspace.openTextDocument(input.uri);
                } catch {
                    continue; // arquivo não pôde ser lido, ignora essa aba
                }
            }

            tabs.push({
                tabId: uriString,
                filename: path.basename(doc.fileName),
                language: doc.languageId,
                content: doc.getText(),
                path: workspacePathFor(input.uri),
            });
        }
    }
    return tabs;
}

async function sendTabsList() {
    if (!socket || !roomCode) {
        return;
    }

    const tabs = await collectOpenTabs();
    tabs.forEach((tab) => lastSentContentByTab.set(tab.tabId, tab.content));

    socket?.emit('tabs_full_state', { room_code: roomCode, tabs });
}

// ---- Árvore do workspace (botão "Diretório") ----

function isBlockedFolderName(name: string): boolean {
    return BLOCKED_FOLDER_NAMES.has(name.toLowerCase());
}

/** Eventos de criação/remoção dentro de pasta bloqueada (ex.: npm install) não mudam a árvore. */
function handleTreeFsEvent(uri: vscode.Uri) {
    if (!socket || !roomCode) {
        return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return;
    }
    const segments = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
    // A própria pasta bloqueada aparecer/sumir conta; o que acontece dentro dela não.
    if (segments.slice(0, -1).some(isBlockedFolderName)) {
        return;
    }
    scheduleWorkspaceTreeSend();
}

function scheduleWorkspaceTreeSend() {
    if (!socket || !roomCode) {
        return;
    }
    if (treeDebounceTimer) {
        clearTimeout(treeDebounceTimer);
    }
    treeDebounceTimer = setTimeout(() => {
        treeDebounceTimer = undefined;
        void sendWorkspaceTree();
    }, TREE_DEBOUNCE_MS);
}

async function readTreeChildren(
    dirUri: vscode.Uri,
    depth: number,
    counter: { count: number; truncated: boolean }
): Promise<TreeNode[]> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
        return []; // sem permissão ou pasta removida durante a leitura
    }

    // Mesma ordem do Explorer do VS Code: pastas primeiro, depois arquivos, cada grupo em ordem alfabética.
    entries.sort((a, b) => {
        const aIsDir = (a[1] & vscode.FileType.Directory) !== 0;
        const bIsDir = (b[1] & vscode.FileType.Directory) !== 0;
        if (aIsDir !== bIsDir) {
            return aIsDir ? -1 : 1;
        }
        return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
    });

    const nodes: TreeNode[] = [];
    for (const [name, type] of entries) {
        if (counter.count >= MAX_TREE_NODES) {
            counter.truncated = true;
            break;
        }
        counter.count++;

        const isDir = (type & vscode.FileType.Directory) !== 0;
        if (!isDir) {
            nodes.push({ name, type: 'file' });
            continue;
        }

        // Pasta bloqueada (ou link simbólico, que pode formar ciclo): aparece, mas sem listar o conteúdo.
        const isSymlink = (type & vscode.FileType.SymbolicLink) !== 0;
        if (isBlockedFolderName(name) || isSymlink) {
            nodes.push({ name, type: 'dir', blocked: true });
            continue;
        }

        if (depth >= MAX_TREE_DEPTH) {
            counter.truncated = true;
            nodes.push({ name, type: 'dir', children: [] });
            continue;
        }

        nodes.push({
            name,
            type: 'dir',
            children: await readTreeChildren(vscode.Uri.joinPath(dirUri, name), depth + 1, counter),
        });
    }
    return nodes;
}

/** Manda a árvore dos workspace folders abertos (lista vazia se não há workspace). */
async function sendWorkspaceTree() {
    if (!socket || !roomCode) {
        return;
    }

    const seq = ++treeBuildSeq;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const counter = { count: 0, truncated: false };
    const roots: TreeNode[] = [];

    for (const folder of folders) {
        counter.count++;
        roots.push({
            name: folder.name,
            type: 'dir',
            children: await readTreeChildren(folder.uri, 1, counter),
        });
    }

    // Uma montagem mais nova já começou (ou a conexão caiu) enquanto esta lia o disco: descarta.
    if (seq !== treeBuildSeq || !socket || !roomCode) {
        return;
    }

    socket.emit('workspace_tree', { room_code: roomCode, tree: roots, truncated: counter.truncated });
}

function handleActiveEditorChange(editor: vscode.TextEditor | undefined) {
    if (!socket || !roomCode || !editor) {
        return;
    }
    if (!isWithinOpenWorkspace(editor.document.uri)) {
        return; // fora do workspace atual — nunca compartilhado (mesma regra da lista de abas)
    }
    // Garante o conteúdo atualizado e manda a linha do cursor para atualizar o indicador de posição.
    sendFullContentFor(editor.document);
    sendCursorLine(editor);
}

function handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
    if (!socket || !roomCode) {
        return;
    }
    if (cursorDebounceTimer) {
        clearTimeout(cursorDebounceTimer);
    }
    cursorDebounceTimer = setTimeout(() => sendCursorLine(event.textEditor), CURSOR_DEBOUNCE_MS);
}

function sendCursorLine(editor: vscode.TextEditor | undefined) {
    if (!editor || !socket || !roomCode) {
        return;
    }
    if (editor.document.uri.scheme !== 'file') {
        return;
    }
    if (!isWithinOpenWorkspace(editor.document.uri)) {
        return; // nem o caminho do arquivo (via tab_id) deve vazar fora do workspace
    }

    socket.emit('host_cursor_line', {
        room_code: roomCode,
        tab_id: tabIdFor(editor.document),
        line: editor.selection.active.line + 1, // 1-based, igual o resto do app
    });
}

function handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
    if (!socket || !roomCode) {
        return;
    }
    if (event.document.uri.scheme !== 'file') {
        return;
    }
    if (!isWithinOpenWorkspace(event.document.uri)) {
        return; // fora do workspace atual — nunca compartilhado
    }

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => sendDiff(event.document), DEBOUNCE_MS);
}

function handleDocumentSave(document: vscode.TextDocument) {
    if (!socket || !roomCode) {
        return;
    }
    if (document.uri.scheme !== 'file') {
        return;
    }
    if (!isWithinOpenWorkspace(document.uri)) {
        return; // fora do workspace atual — nunca compartilhado
    }

    // Cancela diff pendente e manda o conteúdo completo como ponto de convergência garantido.
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
    sendFullContentFor(document);
}

function sendFullContentFor(document: vscode.TextDocument) {
    if (!socket || !roomCode) {
        return;
    }
    if (document.uri.scheme !== 'file') {
        return;
    }
    if (!isWithinOpenWorkspace(document.uri)) {
        return; // defesa em profundidade — mesma regra de segurança de tudo mais aqui
    }

    const tabId = tabIdFor(document);
    const content = document.getText();
    lastSentContentByTab.set(tabId, content);

    socket.emit('file_full_content', {
        room_code: roomCode,
        tab_id: tabId,
        filename: path.basename(document.fileName),
        language: document.languageId,
        content,
        path: workspacePathFor(document.uri),
    });
}

function sendDiff(document: vscode.TextDocument) {
    if (!socket || !roomCode) {
        return;
    }

    const tabId = tabIdFor(document);
    const previousContent = lastSentContentByTab.get(tabId) ?? '';
    const newContent = document.getText();

    // Calcula o patch localmente com diff-match-patch, evitando reenviar o arquivo inteiro a cada edição.
    const diffs = dmp.diff_main(previousContent, newContent);
    const patch = dmp.patch_make(previousContent, diffs);
    const patchText = dmp.patch_toText(patch);

    lastSentContentByTab.set(tabId, newContent);

    socket.emit('file_diff', {
        room_code: roomCode,
        tab_id: tabId,
        patch: patchText,
    });
}
