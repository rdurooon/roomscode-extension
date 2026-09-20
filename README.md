# RoomsCode para VS Code

Extensão complementar da plataforma [RoomsCode](https://github.com/rdurooon/roomscode), usada pelo apresentador (Host) de uma aula ao vivo. Ela conecta o seu VS Code a uma sala RoomsCode e transmite, em tempo real, o conteúdo das abas abertas para os espectadores conectados naquela sala.

## O que ela faz

- Sincroniza **todas** as abas de código abertas no seu editor (não só a ativa), na mesma ordem em que aparecem no VS Code — inclusive se você reordenar as abas depois.
- Atualiza o conteúdo continuamente enquanto você digita (com um pequeno debounce), enviando apenas as alterações — não o arquivo inteiro a cada tecla — e também sempre que você salva (`Ctrl+S`), como reforço de sincronização.
- Envia a linha onde está o seu cursor, permitindo que os espectadores acompanhem automaticamente onde você está no código.
- Restringe a sincronização a arquivos dentro da pasta/workspace atualmente aberta — um arquivo de fora desse workspace nunca chega aos espectadores.

Ela não compartilha sua tela; isso é feito separadamente pelo navegador, na página do Host do RoomsCode.

## Requisitos

- Uma sala já criada na página do Host do RoomsCode (`/anfitriao`), com o **código da extensão** em mãos — aparece atrás do botão fixo "Copiar código da extensão" na tela do Host (é diferente do código de sala, dado aos espectadores).

## Como usar

1. Instale a extensão (veja "Instalação" abaixo).
2. Clique no botão **RoomsCode** na barra de status, no canto inferior esquerdo do VS Code — ou use o Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) e busque por "RoomsCode: Conectar a uma sala".
3. Informe o **código da extensão**, copiado da tela do Host — é o único dado pedido.
4. Uma notificação de progresso mostra o andamento da conexão; depois de conectado, o tooltip do botão da barra de status mostra a latência atual com o servidor.
5. Abra ou edite arquivos normalmente — as abas abertas passam a ser transmitidas para a sala automaticamente.
6. Para encerrar, clique novamente no botão da barra de status ou use o comando "RoomsCode: Desconectar da sala".

Se a conexão cair, a extensão tenta reconectar e reautenticar sozinha, sem precisar digitar o código de novo.

### Usando outro servidor (avançado)

Por padrão a extensão sempre se conecta a `https://roomscode.com`. Para apontar pra outro servidor (ex: uma instância própria em desenvolvimento), use o Command Palette com o comando **"RoomsCode: Conectar a um servidor personalizado (avançado/desenvolvimento)"**.

## Instalação

1. Baixe o arquivo `.vsix` pelo botão de download na tela do Host, em roomscode.com.
2. No VS Code, abra o Command Palette e selecione **Extensions: Install from VSIX...**, e selecione o arquivo baixado. Ou, via terminal: `code --install-extension roomscode-extension-0.0.1.vsix`.

> Por enquanto isso cobre só o lado do Host. O Espectador não precisa de extensão nenhuma.

## Observações de segurança

- A extensão só transmite o que está aberto no editor — nada é lido do disco além disso, e nada fora do workspace atual.
- O token da extensão (código copiado pelo botão "Copiar código da extensão") autentica a conexão e já identifica sozinho qual sala é — sem ele, o backend rejeita qualquer tentativa de publicar conteúdo de arquivo.
- Fechar o VS Code ou usar o comando de desconectar encerra a transmissão imediatamente; a sala em si continua ativa até o Host encerrá-la pelo navegador.
