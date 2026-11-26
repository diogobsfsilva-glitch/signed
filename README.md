# Signed

Plataforma interna de assinatura eletrónica do Grupo Altis Hotels.

- **Assinatura simples**: o signatário desenha, escreve ou carrega a assinatura. O acesso é confirmado por um código enviado por email.
- **Assinatura qualificada com Cartão de Cidadão ou Chave Móvel Digital**: o signatário assina o PDF na app oficial Autenticação.gov e carrega-o no Signed. O Signed confirma que a assinatura é válida e que vem de um certificado do Estado português. Confirma também que pertence à pessoa convidada.

O plano completo, com as fases seguintes, está em [docs/PLANO.md](docs/PLANO.md). As instruções de instalação estão em [docs/INSTALACAO.md](docs/INSTALACAO.md).

## O que já faz (MVP, Fase 1)

| Área | Funcionalidades |
|---|---|
| Documentos | Carregar PDF ou Word (o Word é convertido pelo Microsoft 365), pastas, espaços de trabalho (por hotel ou departamento), pesquisa e filtros |
| Pacotes | Vários ficheiros (PDF ou Word) num só envio: um convite, assinatura de tudo de uma vez, índice dos documentos na página de assinatura. No editor, adicionar, reordenar, renomear e retirar documentos (os campos acompanham). Na conclusão, cada documento também em separado (com o selo do Signed na assinatura simples; cópia para consulta no modo CC), listado no certificado e arquivado no SharePoint em Documentos/ |
| Editor | Destinatários (assina ou recebe cópia), ordem de assinatura, campos de assinatura, iniciais, texto, data, caixa de seleção, opção única, lista e anexo; campos automáticos (nome, email, data de assinatura); valores pré-preenchidos pelo remetente, opcionalmente fixos; arrastar e redimensionar |
| Envio | Assunto e mensagem, prazo, lembretes automáticos, envio sequencial ou em paralelo, corrigir nome, email ou prazo depois de enviar (o link antigo deixa de valer), envio em massa a partir de um modelo e de um CSV |
| Signatário | Link seguro e código por email, preenchimento guiado, assinatura (desenhar, escrever, imagem), anexos (PDF ou imagem, até 10 MB), delegar a outra pessoa, rejeitar com motivo, funciona no telemóvel |
| Cartão de Cidadão | Preenchimento na web, depois descarregar, assinar na app Autenticação.gov e carregar. Validação da cadeia ECRaizEstado, da integridade e da identidade (nome ou nº de identificação civil) |
| Prova | Registo de auditoria encadeado por hashes (inalterável), certificado de conclusão em PDF, selo PAdES da plataforma, SHA-256 do original e do final |
| Conclusão | Email a todos com o PDF final e o certificado, arquivo automático no SharePoint |
| Hotelaria | Assinatura presencial (o hóspede assina no tablet ou PC do colaborador, sem email nem código). Links públicos com código QR a partir de um modelo (termos do spa, piscina, autorizações): cada pessoa cria a sua cópia; limite de utilizações, prazo, confirmação opcional do email por código. Página de assinatura, formulário público e emails ao signatário em PT, EN, ES e FR (idioma por destinatário e seletor na página). Marca por hotel: logótipo e cor por espaço de trabalho. Grupos de assinatura (ex.: Direção Financeira: todos recebem, assina o primeiro, fica registado quem) |
| Acompanhamento | Fim do contrato com alerta de renovação por email, aviso ao remetente a cada assinatura, resumo semanal à segunda-feira, envio agendado, duplicar e corrigir e reenviar, "Para eu assinar" (colaboradores assinam com a conta Microsoft, sem código), Administração → Estado (falhas dos últimos 7 dias) |
| Relatórios | Enviados, concluídos, tempo mediano até concluir, em curso por espaço de trabalho e por remetente, a expirar e parados, exportação CSV; lembrar e cancelar vários documentos de uma vez no painel |
| Modelos (Fase 2) | Modelos partilhados no espaço de trabalho com o PDF, os papéis (ex.: Colaborador, Diretor do hotel) e os campos. Usar um modelo pede só nomes e emails. Qualquer documento pode ser guardado como modelo |
| Administração | Espaços de trabalho, membros e funções, utilizadores, domínios autorizados, login com Microsoft 365 |

## Arquitetura

```
Browser (React + Vite, Cloudflare Pages)
   │  supabase-js (RLS)                 │ fetch
   ▼                                     ▼
Supabase Postgres + Storage  ◄──  Edge Functions (Deno)
   (tabelas, RLS, auditoria)        document-actions  enviar / cancelar / lembrar
                                    signer-api        página do signatário (sem conta)
                                    convert-docx      Word -> PDF (Microsoft Graph)
                                    reminders         lembretes e prazos (pg_cron, de hora a hora)
                                    public-form       links públicos / QR (sem conta)
                                          │
                                          ▼
                                 Microsoft 365 (Graph): email, SharePoint
```

Código importante:

- `supabase/migrations/` — esquema, permissões (RLS) e registo de auditoria.
- `supabase/functions/_shared/pades-verify.ts` — validação das assinaturas do Cartão de Cidadão.
- `supabase/functions/_shared/engine.ts` — fluxo: notificar, preparar o PDF, concluir, arquivar.
- `supabase/functions/_shared/trust-pt.ts` — certificados públicos do Cartão de Cidadão (gerado por `scripts/build-trust-store.mjs` a partir de `certs/pt/`).
- `src/pages/Editor.tsx`, `src/pages/Sign.tsx` — editor de campos e página do signatário.

## Desenvolvimento local

Precisa de Node 22, Docker e (opcional) Deno.

```bash
npm install
npx supabase start            # base de dados, auth, storage e functions locais
cp .env.example .env.local    # e cole a ANON_KEY de `npx supabase status`
# Segredos das functions para desenvolvimento (ver docs/INSTALACAO.md, secção "Local")
npx supabase functions serve --env-file supabase/functions/.env
npm run dev                   # http://127.0.0.1:5173
```

Sem Microsoft 365 configurado, os emails não são enviados e ficam no `email_log` (visível no detalhe do documento). Com `VITE_DEV_LOGIN=true` aparece o login com email e palavra-passe para testes.

### Testes

```bash
npm test            # unitários: PDF, validação CC (PKI de teste), selo, fluxo
npm run test:e2e    # ponta-a-ponta contra o Supabase local (apaga a base de dados local)
```

A PKI de teste (`tests/fixtures/pki`) imita a hierarquia do Cartão de Cidadão com chaves falsas. Só é aceite em desenvolvimento, através da variável `SIGNED_DEV_EXTRA_TRUST_PEM`, que **nunca** pode existir em produção.

## Limitações conhecidas

- **Ainda não foi testado com um Cartão de Cidadão real.** A validação foi testada com uma PKI de teste que reproduz os nomes e a estrutura da hierarquia oficial, e com os certificados oficiais carregados. O primeiro teste real deve ser feito antes de usar em produção (ver docs/INSTALACAO.md, passo 8).
- A revogação dos certificados (OCSP/CRL) não é consultada. Confirma-se a cadeia e a validade, mas não se um cartão foi cancelado.
- Lista de confiança (`certs/pt/`): raízes ECRaizEstado 002 e MULTICERT Root 01, "Cartão de Cidadão 003–008", CAs de assinatura CC 0019/0020 e CMD 00001, 00002, 00005, 00006 e 00007. Os certificados da CMD foram obtidos em pki.cartaodecidadao.pt e verificados criptograficamente contra a CA emissora. Faltam as CMD 00003 e 00004 (o site devolve-as em formato binário que não foi possível obter aqui). Como foram emitidas pela "Cartão de Cidadão 006", que está na lista, são aceites sempre que venham incluídas na assinatura. Quando o Estado emitir novas CAs, acrescente-as a `certs/pt/` e corra `node scripts/build-trust-store.mjs`.
- As verificações ECDSA (P-256, P-384, P-521) são feitas com `@noble/curves`, porque o runtime das Edge Functions do Supabase não suporta P-521 e falha em P-384 (testado). As CAs atuais do Cartão de Cidadão usam estas curvas.
- O plano gratuito do Supabase não faz cópias de segurança. Por isso cada documento concluído é arquivado no SharePoint.
