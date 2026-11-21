# Plano do Signed

Produto interno da Altis com as funcionalidades do signNow. É uma implementação própria ("clean-room"): não usa código, interface, nome nem marca do signNow.

## Decisões

| Tema | Decisão |
|---|---|
| Nome | Signed |
| Utilização | Ferramenta interna do Grupo Altis Hotels |
| Custo | Zero: Supabase gratuito, Cloudflare Pages, Microsoft 365 existente |
| Interface | React + Vite (estática). O plano gratuito do Cloudflare Workers limita o CPU a 10 ms por pedido, o que não chega para renderizar Next.js no servidor; por isso o processamento pesado de PDF corre nas Edge Functions do Supabase |
| Cartão de Cidadão | Desde o início. Opção A: assinar na app Autenticação.gov, depois carregar e validar |

## Fases

- **Fase 1 (MVP), concluída**: ver o README.
- **Fase 2, produtividade**: ~~modelos~~ (feito), envio em massa por CSV, links de assinatura reutilizáveis, envio agendado, campos condicionais e calculados, pacotes de documentos, partilha de pastas, relatórios, marca por hotel.
- **Fase 3, enterprise**: envio e autenticação por SMS, fluxos de aprovação, pagamentos (Stripe), API pública com webhooks, assinatura embebida, integrações (Drive, OneDrive, Zapier), interface em EN/ES/FR.
- **Fase 4, assinatura qualificada integrada**:
  - Opção C (CMD via AMA): tudo no browser. Exige protocolo e certificação com a AMA (contacto eid@ama.pt). **Pedir já**, porque o prazo não depende de nós.
  - Opção B ("Signed Agent"): app local nos PCs da Altis para assinar com o CC sem sair do browser.
  - PWA com digitalização de documentos.

O módulo de validação (`pades-verify.ts`) e a assinatura incremental já estão separados do resto, para que B e C se encaixem sem refazer o fluxo.
