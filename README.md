# Visualization of 2D semantic embedding spaces (motor learning papers)

## Features

- Toggle between embedding spaces

- Display/hide citation network edges

- Color and label by topic or citation community

- Isolate a topic and/or a community

- Highlight intra-topic citation islands (see below)

- Searching and filering

## Intra-topic citation islands

Papers can share a topic (similar text) yet form citation communities that never cite one another. The **Intra-topic citation islands** toggle surfaces this:

- Takes citations *internal* to each topic and computes the
  connected components of that induced subgraph (undirected). If >1 multi-paper component, the topic is probably split into disconnected citation communities.
- The largest component keeps the topic color; other communities are altered in color and size to help visualization; isolated papers are greyed

To see this:
1. Click a topic
2. Choose "isolate this topic"
3. Choose "highlight citation islands" in the topic menu or toggle "intra-topic citation islands" in the left menu

These are recomputed when the embedding model is switched (different topic structure).

## Data 

- Files in the `data` directory; Embedding space-specific data in different subfolders (e.g. `data/gemini`)

- Generated with [this repo](https://github.com/maduarte95/embeddings-motor-learning-network/tree/comparison_metrics).

