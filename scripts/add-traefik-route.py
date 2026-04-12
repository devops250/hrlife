#!/usr/bin/env python3
import json, shutil

CONFIG_PATH = "/etc/easypanel/traefik/config/main.yaml"

with open(CONFIG_PATH) as f:
    config = json.load(f)

# Backup
shutil.copy(CONFIG_PATH, CONFIG_PATH + ".bak")

# Router HTTP -> redirect HTTPS
config["http"]["routers"]["http-sdr-hrlife"] = {
    "service": "sdr-hrlife",
    "rule": "Host(`sdr-hrlife.cognitaai.com.br`)",
    "middlewares": ["redirect-to-https"],
    "entryPoints": ["http"]
}

# Router HTTPS com SSL via Let's Encrypt
config["http"]["routers"]["https-sdr-hrlife"] = {
    "service": "sdr-hrlife",
    "rule": "Host(`sdr-hrlife.cognitaai.com.br`)",
    "tls": {"certResolver": "letsencrypt"},
    "entryPoints": ["https"]
}

# Service apontando para Node.js na porta 3100 do host
config["http"]["services"]["sdr-hrlife"] = {
    "loadBalancer": {
        "servers": [{"url": "http://172.17.0.1:3100"}],
        "passHostHeader": True
    }
}

with open(CONFIG_PATH, "w") as f:
    json.dump(config, f, indent=2)

print("Traefik config atualizada com sucesso!")
print("Rotas adicionadas:")
print("  - http-sdr-hrlife  -> redirect HTTPS")
print("  - https-sdr-hrlife -> http://172.17.0.1:3100")
