# Growth Tool — `generate_growth_report`

## Description

Generates a forward-looking, hyper-personalised financial intelligence report.

---

# TOOL DEFINITION

```json
{
  "name": "generate_growth_report",
  "description": "Generates a forward-looking, hyper-personalised financial intelligence report",
  "inputs": {
    "user_id": "string",
    "time_period": "string",
    "current_state": "object",
    "previous_state": "object",
    "recommendations": "array"
  },
  "output": {
    "report": {
      "headline": "string",
      "system_progress": {
        "net_improvement": "number",
        "drivers": ["string"]
      },
      "key_insights": [
        {
          "insight": "string",
          "impact": "number"
        }
      ],
      "forward_outlook": {
        "projected_gain": "number",
        "time_horizon": "string"
      },
      "next_actions": [
        {
          "action": "string",
          "impact": "number"
        }
      ]
    }
  },
  "rules": [
    "Must include forward-looking analysis",
    "Must be personalised to user financial system",
    "Must avoid generic summaries",
    "Must quantify improvement and future opportunity"
  ]
}
```

---

# WHERE THIS FITS IN THE SYSTEM

After Wealth Manager:

```typescript
if (isEndOfMonth) {
  const growthTrigger = runGrowthAgent(...)
  if (growthTrigger.priority === "high") {
    const report = generate_growth_report(...)
  }
}
```

---

# SYSTEM ROLE

Acts as:
→ The **structured growth output generator**
