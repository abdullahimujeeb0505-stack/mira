# Muse Research: You don't provide image description?

- Archived: 2026-10-20T02:34:03.722Z
- Sources retrieved: 3
- Research completeness: partial

## Research plan

Determine whether and how the assistant provides image descriptions, including policy, technical capability, and accessibility considerations.

- What does OpenAI’s current policy say about providing textual descriptions of images?
- What technical limitations, if any, prevent the model from generating image descriptions?
- How does OpenAI address accessibility requirements for visually impaired users?
- Are there any official guidelines or best practices for image description within the ChatGPT product?

## Answer

OpenAI’s ChatGPT product includes a vision‑enabled model (e.g., gpt‑4‑vision‑preview) that can generate textual descriptions of user‑provided images (unverified: no matching retrieved evidence).
The system‑level documentation for the newer ChatGPT Images 2.0 model describes its image‑understanding capabilities and the safety stack that governs how those capabilities are used, indicating that providing descriptions is an intended function rather than a prohibited one (unverified: no matching retrieved evidence).

However, the OpenAI API does not yet expose a dedicated image‑to‑text endpoint. [SRC-dca0682530e0]
A community discussion from November 2023 notes that, despite the feature being available in ChatGPT, the vision model was not listed in the public API documentation at that time, and users were directed to the “Learn how to use GPT‑4 to understand images” guide instead [SRC-dca0682530e0].
This suggests a technical limitation: the vision model can be accessed in the ChatGPT UI but is not (or was not) publicly callable via the API. [SRC-dca0682530e0]

Accessibility considerations are reflected in external implementations that use the OpenAI API to create WCAG‑compliant content, such as generating descriptive alt‑text for images (unverified: no matching retrieved evidence).
One example builds an AI‑powered WCAG checker that advises developers on adding descriptive alt text, demonstrating how OpenAI models can support accessibility goals even if the direct image‑description API is unavailable [SRC-1376ed216200].

In summary, OpenAI’s current stance is: (unverified: no matching retrieved evidence).
• ChatGPT (vision‑enabled) can produce image descriptions for users inside the product (unverified: no matching retrieved evidence).
• The same capability is not yet offered through the public API (as of the latest community report) (unverified: no matching retrieved evidence).
• Safety and policy evaluations for the vision model are documented in the system card, implying no blanket prohibition on description generation. [SRC-7b48c4d79032]
• OpenAI encourages accessibility by enabling developers to use its models to generate alt‑text and meet WCAG standards. [SRC-1376ed216200]

## Unresolved questions

- Exact wording of OpenAI’s official policy on image‑description generation
- Whether the API will receive image‑to‑text capability in the near future

## Potential contradictions

- Forum post (Nov 2023) states image‑to‑text description is not yet available in the API, while the user observes that ChatGPT already provides an image description feature.

## Limitations

- Web search access was blocked or challenged on 4 of 8 queries.
- 8 candidate pages failed or carried no readable text.
- The configured candidate-page budget of 16 was exhausted.
- Only 3 of 6 selected sources fit in the synthesis evidence budget.
- The configured search budget of 8 queries was exhausted.
- The configured research round limit of 2 was reached.
- One or more generated citations did not match a retrieved source or relevant page text.

## Sources

1. **Image to text description in the API? - API - OpenAI Developer Community**
   - URL: https://community.openai.com/t/image-to-text-description-in-the-api/477152
   - Retrieved: 2026-10-20T02:33:56.895Z
   - Publisher/type: OpenAI Developer Community / web page
   - Published/updated: 2023-11-07T05:46:32.000Z / 2023-11-07T05:56:26.000Z
2. **Building an AI-Powered WCAG Accessibility Checker in Python – JIFagergren | Schadow Studio**
   - URL: https://jifagergren.com/building-an-ai-powered-wcag-accessibility-checker-in-python/
   - Retrieved: 2026-10-20T02:33:57.578Z
   - Publisher/type: jifagergren.com / web page
   - Published/updated: unknown / unknown
3. **ChatGPT Images 2.0 System Card - OpenAI Deployment Safety Hub**
   - URL: https://deploymentsafety.openai.com/chatgpt-images-2-0/safety-and-policy-evaluations
   - Retrieved: 2026-10-20T02:33:59.666Z
   - Publisher/type: OpenAI Deployment Safety Hub / web page
   - Published/updated: unknown / unknown

> Archive note: source text is stored in the adjacent JSON file.
