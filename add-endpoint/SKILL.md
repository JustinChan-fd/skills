---
name: add-endpoint
description: Orchestrated endpoint addition - strictly follows docs/services/* patterns (Sonnet orchestrator + Haiku subagents)
model: anthropic.claude-sonnet-4-5-20250929-v1:0
---

# Add Endpoint (Orchestrated)

Adds server-side API endpoint methods to services by **strictly following documented patterns**. Sonnet orchestrates, Haiku executes.

## Critical Rules

🚨 **DOCUMENTATION IS SOURCE OF TRUTH** 🚨

**Before ANY implementation, read these in order:**
1. `docs/services/architecture.md` - Patterns & conventions
2. `docs/services/creating-services.md` - Step-by-step guide
3. `docs/services/api-references.md` - API documentation links (Swagger/OpenAPI)
4. `app/src/services/catalog-management/index.js` - Reference implementation

**Optional: Fetch OpenAPI spec** to verify endpoint path, methods, parameters:
```bash
# Example: Verify endpoint exists in API spec
curl https://int-catalog-svc-management.mta.fand.co/openapi.json | jq '.paths."/v1/entertainment/resource"'
```

**Rules:**
- NEVER deviate from documented patterns
- NEVER invent patterns - only use what's documented
- Verify against reference implementation AND API spec before finalizing

## Model Strategy

- **Sonnet (this skill)**: Orchestrate, read docs, validate patterns
- **Haiku (subagents)**: Execute mechanical tasks (add code, tests)

## Workflow

### Phase 1: Analysis (Orchestrator)

1. **Read docs** (architecture.md, creating-services.md, api-references.md, reference implementation)
2. **Optional: Fetch OpenAPI spec** to verify endpoint exists and get parameter details
3. **Extract**: resource name, HTTP method, endpoint path, parameters
4. **Determine pattern**:
   - CRUD resource → `createCatalogResource('/v1/path', 'name')`
   - Custom method → async function with URLSearchParams (GET) or body (POST)
5. **Plan**: exact code + tests (≥4 cases, ≥90% coverage)

### Phase 2: Implementation (Subagent)

Spawn Haiku with exact code to add:

```
Add this EXACT code (no modifications):

File: catalog-management/index.js
[exact code block]

File: catalog-management/index.test.js
[exact test blocks]

Run: npm test -- src/services/catalog-management/index.test.js
Verify: coverage ≥ 90%
```

### Phase 3: Validation (Orchestrator)

- Code matches docs exactly
- Tests pass, coverage ≥ 90%
- No deviations

## Patterns

**CRUD Resource** (8 lines):
```javascript
newResource: createCatalogResource('/v1/domain/resource', 'resource name'),
```
Gives: `get(id)`, `getAll()`, `post(data)`, `put(data)`, `patch(data)`, `delete(id)`

**Custom Method**:
```javascript
customMethod: async (param, options = {}) => {
  const params = new URLSearchParams({
    param_name: param,
    page: options.page || 1,
    pageSize: options.pageSize || 250,
  });
  return await apiFetch(`/v1/path/endpoint?${params}`);
},
```

## Tests

Reference: `catalog-management/index.test.js`

Required coverage:
- Happy path
- Error handling (400, 500)
- 401 auth flow
- Parameter variations
- ≥90% coverage

## Output

```
✅ Added [methodName] to catalogManagementService
Pattern: [CRUD | Custom]
Files: index.js (+N lines), index.test.js (+N tests)
Tests: ✅ passing | Coverage: X%
```

## Pattern Deviation

If implementation deviates:
```
❌ PATTERN DEVIATION DETECTED
Expected: [from docs]
Actual: [implemented]
Action: Revert → re-implement EXACT pattern
```
