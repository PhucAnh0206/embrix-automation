---
aliases: [Notification Engine, Email Templates, SMS]
tags: [embrix/operations, embrix/notification]
type: knowledge
hub: Operations
created: 2026-05-07
sources: ["8 - Embrix User Guide - Operations Hub_pdf.md"]
---

# ⚙️ Notification Engine

> **Parent**: [[00-MOC-Embrix-Knowledge-Base]] | **Hub**: Operations
> **Related**: [[41-AR-Collections]] | [[61-OPS-Jobs-Management]] | [[05-ARCH-Message-Broker]]

---

## 1. Notification Channels

| Channel | Use Case |
|---------|----------|
| **Email** | Invoices, reminders, welcome emails |
| **SMS** | Payment reminders, service alerts |
| **In-App** | Dashboard notifications |
| **Webhook** | External system notifications |

## 2. Template Configuration

| Field | Description |
|-------|-------------|
| **Template Name** | Identifier |
| **Channel** | Email / SMS / In-App |
| **Subject** | Email subject (supports variables) |
| **Body** | Message body with merge fields |
| **Trigger** | Event that sends notification |

## 3. Merge Fields

```
{{account.name}}, {{invoice.number}}, {{invoice.total}},
{{invoice.dueDate}}, {{payment.amount}}, {{subscription.plan}}
```

## 4. Trigger Events

| Event | Default Notification |
|-------|---------------------|
| Invoice generated | Email with PDF attachment |
| Payment received | Email confirmation |
| Payment failed | Email + SMS alert |
| Service suspended | Email + SMS |
| Dunning stage change | Per dunning config |

---

*Back to [[00-MOC-Embrix-Knowledge-Base]]*
