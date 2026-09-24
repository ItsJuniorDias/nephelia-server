#!/usr/bin/env bash
# Baixa o Godot oficial para Linux (o mesmo da versão do jogo) em ./bin/godot. Roda no build do
# Render (Build Command: npm ci && bash scripts/install_godot.sh). No Mac não precisa: lá o
# matchmaker usa o Godot que já está instalado (--godotBin).
set -euo pipefail

VERSION="${GODOT_VERSION:-4.7.2-stable}"
case "$(uname -m)" in
	x86_64 | amd64) ARCH="x86_64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*) echo "arquitetura não suportada: $(uname -m)" >&2; exit 1 ;;
esac
NAME="Godot_v${VERSION}_linux.${ARCH}"
URL="https://github.com/godotengine/godot/releases/download/${VERSION}/${NAME}.zip"

cd "$(dirname "$0")/.."
if [ -x bin/godot ] && bin/godot --version 2>/dev/null | grep -q "${VERSION%-stable}"; then
	echo "Godot ${VERSION} já está em bin/godot"
	exit 0
fi
mkdir -p bin
echo "baixando ${URL}"
curl -fsSL -o bin/godot.zip "${URL}"
if command -v unzip >/dev/null 2>&1; then
	unzip -o -q bin/godot.zip -d bin
else
	python3 -m zipfile -e bin/godot.zip bin
fi
mv "bin/${NAME}" bin/godot
chmod +x bin/godot
rm bin/godot.zip
bin/godot --version
if [ ! -f game/nephelia_server.pck ]; then
	echo "AVISO: falta game/nephelia_server.pck (exportado do jogo, preset Linux Server)" >&2
fi
