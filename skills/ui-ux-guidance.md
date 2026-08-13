# UI UX Guidance

Skill id: `ui-ux-guidance`  
Kind: `guidance`  
Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill  
Source snapshot: 2026-08-13

## Purpose
Use this guidance for work that changes visual structure, layout, interaction, navigation, accessibility, animation, or data presentation. It distills product-design principles without depending on the upstream search runtime.

Skip it for pure backend, infrastructure, repository maintenance, or other work with no visual or interaction consequence.

## Start from the product that exists
Before recommending or implementing UI changes:
- inspect the existing screens, components, navigation, and interaction patterns;
- detect the actual platform, framework, styling system, and reusable primitives from repository evidence;
- preserve established product patterns unless the requirement explicitly changes them;
- prefer stack-specific advice only when the project context proves the stack.

For a new screen or a material redesign, establish a coherent design direction before implementation. State the intended hierarchy, density, interaction model, and important trade-offs instead of choosing arbitrary styling.

## Design quality checklist
Consider the parts that materially affect the request:
- **Hierarchy:** make primary actions, information, and next steps visually obvious.
- **Spacing and density:** use a consistent rhythm and match density to the product and task frequency.
- **Typography and color:** use them to communicate hierarchy, meaning, and emphasis; maintain readable contrast.
- **States and feedback:** design loading, empty, error, disabled, selected, hover/focus, success, and progress states when relevant.
- **Responsive behavior:** define how layout, navigation, controls, and information priority adapt when space changes.
- **Accessibility:** support keyboard/focus behavior where applicable, meaningful labels, sufficient contrast, usable target sizes, and non-color-only cues.
- **Interaction quality:** keep controls predictable, feedback timely, navigation understandable, and destructive or irreversible actions explicit.
- **Animation:** use motion only when it clarifies change, continuity, hierarchy, or feedback; avoid decorative motion that harms speed or accessibility.
- **Data presentation:** optimize scanability, comparison, formatting, empty states, and progressive detail for the user's decision task.

## Decision rules
Prefer the smallest design change that produces a coherent experience. Reuse existing components and conventions before inventing new ones. When requirements conflict with existing patterns, explain why the exception is justified and what consistency cost it creates.

Call out meaningful trade-offs such as compactness versus readability, discoverability versus visual noise, immediacy versus confirmation, or flexibility versus consistency. Recommendations should connect to user behavior and product constraints, not personal taste.

## Visual evidence in DevFlow
When visual proof, a mockup, layout comparison, or product UI preview is useful, use **DevFlow UI Preview** and attach that evidence to the relevant task when appropriate. Do not substitute generated images for a product UI preview. Image generation is not required by this guidance.

## Runtime boundary
This is guidance content only. It does not require or invoke Python, Node.js, a CLI, CSV design databases, templates, external packages, generated design-system files, or upstream agent-specific filesystem paths.
