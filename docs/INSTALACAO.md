# Instalação do Signed (custo zero)

Tempo estimado: 1 a 2 horas, com alguém da informática para os passos do Microsoft 365 (3 e 4).

Componentes, todos em plano gratuito:

| Serviço | Para quê | Limites do plano gratuito |
|---|---|---|
| Supabase (região Frankfurt) | Base de dados, ficheiros, login, funções | 500 MB de base de dados, 1 GB de ficheiros, sem backups, pausa após 7 dias sem uso |
| Cloudflare Pages | Site (interface) | Uso comercial permitido, sem limite de tráfego estático |
| Microsoft 365 da Altis | Login, emails, SharePoint, Word→PDF | Já pago pela Altis |

---

## 1. Supabase

1. Criar conta em supabase.com e um projeto novo: nome `signed`, região **Central EU (Frankfurt)**, com uma palavra-passe forte para a base de dados.
2. No computador, na pasta do projeto:
   ```bash
   npx supabase login
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase db push
   npx supabase functions deploy document-actions signer-api convert-docx reminders --no-verify-jwt
   ```
   (`--no-verify-jwt` é intencional: `signer-api` é pública para os signatários, e as outras validam o utilizador por dentro.)
3. **Authentication → Providers**: desligar **Email** (em produção só se entra com Microsoft).
4. **Authentication → URL Configuration**: Site URL = endereço do Cloudflare (passo 5), por exemplo `https://signed.pages.dev`.
5. **Database → Extensions**: ativar `pg_cron` e `pg_net`.

## 2. Segredos das funções

```bash
bash scripts/generate-seal-cert.sh          # cria o certificado do selo
npx supabase secrets set \
  APP_URL=https://signed.pages.dev \
  SIGNER_LINK_SECRET=$(openssl rand -hex 32) \
  CRON_SECRET=$(openssl rand -hex 24) \
  SEAL_CERT_PEM="$(cat seal-cert.pem)" \
  SEAL_KEY_PEM="$(cat seal-key.pem)"
```

Guarde o `CRON_SECRET` para o passo 6. **Não** defina `SIGNED_DEV_EXTRA_TRUST_PEM` nem `PUBLIC_API_URL` em produção.

> Se `SIGNER_LINK_SECRET` mudar, os links já enviados deixam de funcionar.

## 3. Microsoft Entra ID: login dos colaboradores

Em entra.microsoft.com → **App registrations → New registration**:

- Nome: `Signed – Login`
- Contas: *Accounts in this organizational directory only*
- Redirect URI (Web): `https://<PROJECT_REF>.supabase.co/auth/v1/callback`

Depois:

- **Certificates & secrets** → novo *client secret* (anotar o valor).
- No Supabase → **Authentication → Providers → Azure**: ativar, colar o *Application (client) ID* e o *secret*, e em *Azure Tenant URL* colocar `https://login.microsoftonline.com/<TENANT_ID>`.

Só entram emails dos domínios em **Administração → Definições** (por omissão, `altishotels.com`). **A primeira pessoa a entrar fica administradora.**

## 4. Microsoft Graph: emails, SharePoint e Word→PDF

Segunda aplicação (ou a mesma), **App registrations → New registration**, `Signed – Serviço`:

1. **API permissions → Microsoft Graph → Application permissions**: `Mail.Send` e `Sites.Selected`. Depois clicar em **Grant admin consent**.
2. **Certificates & secrets** → novo secret.
3. Criar a caixa de correio do remetente, por exemplo `signed@altishotels.com` (pode ser uma caixa partilhada).
4. Limitar o `Mail.Send` a essa caixa (Exchange Online PowerShell):
   ```powershell
   New-DistributionGroup -Name "Signed-Senders" -Type Security -Members signed@altishotels.com
   New-ApplicationAccessPolicy -AppId <CLIENT_ID> -PolicyScopeGroupId Signed-Senders -AccessRight RestrictAccess -Description "Signed só envia desta caixa"
   ```
5. Criar (ou escolher) um site SharePoint para o arquivo, por exemplo `Contratos`, e obter o ID:
   `GET https://graph.microsoft.com/v1.0/sites/altishotels.sharepoint.com:/sites/Contratos` (no Graph Explorer). O `id` tem a forma `altishotels.sharepoint.com,xxxx,yyyy`.
6. Dar acesso de escrita só a esse site (Graph Explorer, com uma conta de administrador):
   ```http
   POST https://graph.microsoft.com/v1.0/sites/<SITE_ID>/permissions
   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<CLIENT_ID>", "displayName": "Signed – Serviço" } }] }
   ```
7. Segredos:
   ```bash
   npx supabase secrets set \
     M365_TENANT_ID=<TENANT_ID> M365_CLIENT_ID=<CLIENT_ID> M365_CLIENT_SECRET=<SECRET> \
     M365_SENDER=signed@altishotels.com \
     M365_SHAREPOINT_SITE_ID=<SITE_ID> M365_ARCHIVE_FOLDER=Signed
   ```

O arquivo fica em `Signed/<ano>/<espaço de trabalho>/<título>_<id>/`.

## 5. Cloudflare Pages (interface)

1. dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** e escolher `diogobsfsilva-glitch/signed`.
2. Build command: `npm run build`. Output: `dist`.
3. Variáveis de ambiente:
   - `VITE_SUPABASE_URL` = `https://<PROJECT_REF>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = a chave pública (*publishable/anon*) do Supabase (Project Settings → API)
   - **não** definir `VITE_DEV_LOGIN`
4. Opcional: domínio próprio, por exemplo `signed.altishotels.com` (atualizar `APP_URL` e o Site URL do Supabase).

Cada `git push` para `main` publica automaticamente.

## 6. Lembretes automáticos

No Supabase → **SQL Editor**, correr `supabase/cron.sql` depois de substituir `<PROJECT_REF>` e `<CRON_SECRET>`.

## 7. Verificação

1. Entrar com a conta Microsoft (fica administrador).
2. **Administração → Espaços de trabalho**: criar um por hotel ou departamento, se quiser.
3. Enviar um documento em modo simples para o seu email pessoal e assinar. Verificar o email, o PDF final, o certificado e a pasta no SharePoint.

## 8. Primeiro teste com Cartão de Cidadão (obrigatório antes de usar)

1. Criar um documento em modo **Cartão de Cidadão** com um signatário (o seu nome, como está no cartão).
2. Na página do signatário: descarregar, assinar na app Autenticação.gov com o CC (e outro teste com a Chave Móvel Digital) e carregar.
3. Confirmar que o Signed aceita e mostra o seu nome e a entidade emissora.
4. Abrir o PDF final no Adobe Acrobat Reader ou na app Autenticação.gov (validação) e confirmar que a assinatura aparece como válida.

Se o Signed recusar a assinatura, a mensagem de erro e o detalhe em **Histórico → Assinatura CC recusada** indicam o motivo. Envie essa informação para o ajuste.

## Local

Ficheiro `supabase/functions/.env` (não vai para o Git):

```
SIGNER_LINK_SECRET=<64 caracteres aleatórios>
APP_URL=http://127.0.0.1:5173
CRON_SECRET=dev-cron-secret-change-me
PUBLIC_API_URL=http://127.0.0.1:54321
SEAL_CERT_PEM="<conteúdo de tests/fixtures/pki/seal.pem com \n>"
SEAL_KEY_PEM="<conteúdo de tests/fixtures/pki/seal.p8 com \n>"
SIGNED_DEV_EXTRA_TRUST_PEM="<root.pem + cc008.pem + sigca.pem + cc008ec.pem da PKI de teste>"
```
