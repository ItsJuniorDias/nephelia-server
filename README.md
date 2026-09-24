# nephelia-server

Backend das partidas online do **Nephelia**: o matchmaker, em Node.js + TypeScript.

## Como funciona

```
 jogo (Windows, Mac, iPhone, Android)
    │  1. POST /v1/matchmake  {"version":1,"name":"Alex","platform":"ios"}
    ▼
 matchmaker (este projeto, Node.js)  ──── 2. abre/fecha ────►  servidor da partida (Godot sem tela)
    │                                ◄─── 3. "ready", "status" ── (uma linha por evento na saída)
    │  4. {"host":"1.2.3.4","port":24700}
    ▼
 jogo conecta direto no servidor da partida (UDP, ENet) e joga
```

- **O matchmaker não simula a partida.** Quem simula é o próprio jogo rodando sem tela, com
  física, bots e compensação de atraso. É o mesmo código do anfitrião do multiplayer no Wi-Fi.
  Cada partida é um processo do Godot numa porta UDP.
- Quem pede partida vai para **a mais cheia que ainda tem vaga**: até 4 pessoas por partida, e os
  bots completam o resto. Sem vaga, o matchmaker abre uma partida nova.
- A vaga fica **guardada por 20 s** (`reservationMs`) até a pessoa aparecer, para dois pedidos ao
  mesmo tempo não lotarem a mesma partida.
- **Uma partida vazia fica sempre pronta** (`warmMatches`), para quem chega entrar na hora. As
  outras vazias fecham depois de 2 min (`idleShutdownMs`).
- Versão do jogo diferente da do servidor → resposta **426**, e o jogo pede para atualizar.
- **Limite de pedidos por IP** (12 por minuto).

### Conversa com o servidor da partida

O matchmaker abre cada partida assim:

```
<godotBin> <godotArgs...> -- --server --port=24700 --match-id=m1 --max-players=4
```

O servidor escreve na saída padrão uma linha por evento (o resto é log do Godot):

```
NEPHELIA {"event":"ready","port":24700,"version":1}
NEPHELIA {"event":"status","humans":2,"state":"running","time_left":123.4}
NEPHELIA {"event":"bye","reason":"closing"}
```

Do lado do jogo: `net/dedicated_server.gd` (servidor) e `net/online_matchmaker.gd` (cliente), no
repositório do jogo.

### API

| Rota | Resposta |
|---|---|
| `GET /v1/health` | `200 {"ok":true}` |
| `GET /v1/status` | `200 {"players":3,"matches":2}` |
| `POST /v1/matchmake` | `200 {"host","port","match","ticket"}` · `400` pedido estragado · `426` atualizar o jogo · `429` pedidos demais · `503` sem vaga · `502` a partida não abriu |

## Rodar no Mac

Precisa do Node.js 24 ou mais novo. Ele roda o TypeScript direto, sem compilar.

```bash
npm install
npm test            # testes (node:test)
npm run typecheck   # confere os tipos (tsc)
```

Matchmaker local usando o projeto do jogo, que precisa estar em `../nephelia`:

```bash
node src/main.ts --godotBin="$HOME/Downloads/Godot.app/Contents/MacOS/Godot" \
  --godotArgs="--headless --path $HOME/nephelia" --publicHost=127.0.0.1
```

Para o jogo usar esse matchmaker, abra o jogo com `-- --matchmaker=http://127.0.0.1:8080`: o botão
PLAY ONLINE aparece na tela MULTIPLAYER. No jogo publicado, o endereço fica em
`OnlineMatchmaker.SERVICE_URL`.

## Configuração

Tudo por variáveis de ambiente `NEPHELIA_*` (ver `.env.example`) ou `--chave=valor`:

| Campo | Padrão | O que é |
|---|---|---|
| `httpPort` | 8080 | porta da API |
| `publicHost` | 127.0.0.1 | IP ou domínio que os jogadores usam para chegar nas partidas |
| `godotBin`, `godotArgs` | godot, `--headless` | como abrir o servidor da partida |
| `matchPortFirst`–`matchPortLast` | 24700–24719 | portas UDP das partidas (liberar no firewall) |
| `maxMatches` | 8 | partidas ao mesmo tempo |
| `maxPlayers` | 4 | pessoas por partida (igual a `Net.MAX_PLAYERS` no jogo) |
| `warmMatches` | 1 | partidas vazias já prontas |
| `idleShutdownMs` | 120000 | partida vazia fecha depois disso |
| `protocolVersion` | 1 | igual a `NetMessage.VERSION` no jogo |

## Onde hospedar

As partidas usam **UDP** (ENet) nas portas 24700–24719, e cada partida é o jogo inteiro rodando
física e bots. Por isso o servidor precisa de uma **máquina virtual (VPS) com IP público e UDP
liberado**, com pelo menos 1 GB de RAM por 2 ou 3 partidas.

- **Serve:** Oracle Cloud (grátis, ver abaixo) ou qualquer VPS (Vultr, AWS Lightsail, Hetzner,
  DigitalOcean).
- **Não serve:** Render, Vercel, Heroku, Railway e parecidos. Eles só repassam HTTP, não UDP, e o
  plano grátis deles é pequeno demais e dorme sem uso. O matchmaker até sobe lá, mas não tem onde
  abrir as partidas ("spawn godot ENOENT"), e os jogadores não conseguiriam conectar.

## Colocar no ar (Oracle Cloud, grátis, São Paulo)

1. **Conta:** crie a conta em oracle.com/cloud/free. Escolha **Brazil East (São Paulo)** como
   região principal (*home region*). As máquinas grátis só existem nessa região, e ela **não pode ser
   trocada depois**. O cadastro pede cartão, mas o "Always Free" não cobra.
2. **Máquina:** Compute → Instances → Create. Imagem **Ubuntu 24.04** e forma **Ampere A1**
   (`VM.Standard.A1.Flex`), com 2 núcleos (OCPU) e 12 GB, que ficam dentro do grátis. Mantenha o IP
   público e guarde a chave SSH. Se aparecer "Out of capacity", tente de novo mais tarde.
3. **Portas na nuvem:** Networking → Virtual Cloud Networks → a rede da máquina → Security List →
   Add Ingress Rules:
   - TCP 8080 (matchmaker), origem `0.0.0.0/0`
   - UDP 24700–24719 (partidas), origem `0.0.0.0/0`
4. **Portas na máquina** (o Ubuntu da Oracle bloqueia tudo por padrão), pelo SSH:
   ```bash
   sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
   sudo iptables -I INPUT -p udp --dport 24700:24719 -j ACCEPT
   sudo netfilter-persistent save
   ```
5. **Node.js 24:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
6. **Servidor do jogo:** o Godot oficial para Linux arm64 roda o pacote do jogo (`.pck`, exportado
   no Mac pelo preset "Linux Server" do projeto do jogo):
   ```bash
   sudo mkdir -p /opt/nephelia && cd /opt/nephelia
   sudo apt-get install -y unzip
   sudo curl -LO https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.arm64.zip
   sudo unzip Godot_v4.7.2-stable_linux.arm64.zip && sudo mv Godot_v4.7.2-stable_linux.arm64 godot
   # do Mac: scp nephelia_server.pck ubuntu@<IP>:/tmp/ && sudo mv /tmp/nephelia_server.pck /opt/nephelia/
   ./godot --headless --main-pack nephelia_server.pck -- --server --port=24799   # teste: deve
   # aparecer NEPHELIA {"event":"ready",...}; Ctrl+C para sair
   ```
   No `.env`: `NEPHELIA_GODOT_BIN=/opt/nephelia/godot` e
   `NEPHELIA_GODOT_ARGS=--headless --main-pack /opt/nephelia/nephelia_server.pck`.
7. **Matchmaker:**
   ```bash
   sudo useradd --system --home /opt/nephelia-server nephelia
   sudo git clone <este repositório> /opt/nephelia-server
   cd /opt/nephelia-server && sudo npm ci --omit=dev
   sudo cp .env.example .env   # ajuste NEPHELIA_PUBLIC_HOST = IP público da máquina
   sudo chown -R nephelia /opt/nephelia /opt/nephelia-server
   sudo cp deploy/nephelia-matchmaker.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now nephelia-matchmaker
   curl http://localhost:8080/v1/health
   ```
8. **Jogo:** coloque `http://<IP público>:8080` em `OnlineMatchmaker.SERVICE_URL` e publique a
   atualização.

**Depois:** um domínio com HTTPS (por exemplo com o Caddy na frente do matchmaker); outras regiões,
se aparecerem jogadores longe do Brasil; login com Steam e Game Center, amigos e ranking.
