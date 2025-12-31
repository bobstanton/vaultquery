# VaultQuery Development Guidelines

## Code Quality Principles

### ❌ **NEVER Add Fallbacks Without Explicit Request**

**Rule**: Do not implement fallback mechanisms, workarounds, or alternative approaches unless explicitly requested.

**Why**: Fallbacks hide bugs and mask the real underlying issues that need to be fixed.

#### Examples of What NOT to Do

```typescript
// ❌ WRONG: Adding fallbacks without being asked
if (blockCache?.position) {
    // Use BlockCache
} else if (storedOffsets) {
    // Use stored offsets  
} else {
    // Fallback to line-based updates
}
```

```typescript
// ❌ WRONG: Try-catch with silent fallback
try {
    await officialAPI();
} catch (error) {
    // Silently fall back to manual approach
    await manualWorkaround();
}
```

#### What TO Do Instead

```typescript
// ✅ CORRECT: Single implementation, fail fast
if (!blockCache?.position) {
    throw new Error('BlockCache position not found. Ensure content has block references.');
}

// Use BlockCache approach only
const result = updateViaBlockCache(blockCache.position);
```

```typescript
// ✅ CORRECT: Proper error handling without fallbacks
try {
    await officialAPI();
} catch (error) {
    // Log the actual error and let it bubble up
    console.error('Official API failed:', error);
    throw error;
}
```

### The Right Way to Handle "Missing" Functionality

When a feature doesn't work as expected:

1. **Identify the root cause** - don't work around it
2. **Fix the underlying issue** - don't mask it
3. **Document requirements** - don't assume user behavior
4. **Fail fast with clear messages** - don't hide problems

#### Example: BlockCache Requirements

Instead of adding fallbacks for content without block references:

```markdown
## BlockCache Write Operations

**Requirement**: Content must have block references for write operations to work.

**Example**:
```markdown
- [ ] Task one ^task-1
- [ ] Task two ^task-2
```

**If tasks don't have block references**: Write operations will not find them. Add block references to enable write sync.

**Error Message**: "No block_id found for task. Add block references (^block-id) to enable write operations."
```

### When Fallbacks ARE Appropriate

Fallbacks should only be implemented when:

1. **Explicitly requested** by the maintainer
2. **Part of the design** from the beginning
3. **Handling external system failures** (network, file system)
4. **Graceful degradation is the intended behavior**

#### Example of Legitimate Fallback

```typescript
// ✅ CORRECT: When explicitly designed for graceful degradation
async function getFileContent(path: string): Promise<string> {
    try {
        // Primary: Use Obsidian's cached read
        return await this.app.vault.cachedRead(file);
    } catch (error) {
        // Fallback: Direct file read (explicitly part of design)
        console.warn('Cached read failed, using direct read:', error);
        return await this.app.vault.read(file);
    }
}
```

## Implementation Strategy

### Single Implementation Principle

- **Choose one approach** and implement it well
- **Document requirements** clearly
- **Fail with helpful error messages** when requirements aren't met
- **Let the user decide** how to meet the requirements

### Error Messages Should Guide Users

```typescript
// ✅ GOOD: Clear, actionable error message
throw new Error(
    'Task update failed: No block reference found. ' +
    'Add block references like ^task-1 to enable write operations.'
);
```

```typescript
// ❌ BAD: Generic error that doesn't help
throw new Error('Task update failed');
```

## Code Review Checklist

Before implementing any solution:

- [ ] Is this the simplest approach that works?
- [ ] Am I adding fallbacks unnecessarily?
- [ ] Are the requirements clearly documented?
- [ ] Do error messages guide users to solutions?
- [ ] Am I hiding bugs instead of fixing them?

## Summary

**The golden rule**: When something doesn't work, fix the real problem. Don't work around it unless explicitly asked to provide fallback behavior.

This leads to:
- ✅ Cleaner, more maintainable code
- ✅ Better user understanding of requirements
- ✅ Actual bugs get fixed instead of hidden
- ✅ More reliable software overall