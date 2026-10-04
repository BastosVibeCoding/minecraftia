Exécute la commande Minecraft `$ARGUMENTS` sur le serveur du VPS via RCON :
`ssh -i ~/.ssh/contabo_minecraft root@169.58.55.167 'docker exec mc-server rcon-cli "<commande>"'`
Attention : entourer la commande de quotes simples côté distant pour que `~` ne soit pas développé par le shell.
