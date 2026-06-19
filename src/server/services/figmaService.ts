export class FigmaService {
  constructor(private figmaToken: string) {}

  private async fetchFigmaApi(path: string) {
    if (!this.figmaToken) {
      throw new Error('Figma token is not configured. Please configure it in Settings.');
    }
    const response = await fetch(`https://api.figma.com/v1${path}`, {
      headers: {
        'X-Figma-Token': this.figmaToken,
      },
    });

    if (!response.ok) {
      let errorMessage = `Figma API Error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.err) {
          errorMessage += ` - ${errorData.err}`;
        }
      } catch (e) {
        // Ignore json parse errors
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }

  async getFigmaFile(fileKey: string) {
    // Fetch file with shallow depth to keep it compact
    const data = await this.fetchFigmaApi(`/files/${fileKey}?depth=1`);
    return {
      name: data.name,
      lastModified: data.lastModified,
      thumbnailUrl: data.thumbnailUrl,
      version: data.version,
      document: data.document,
    };
  }

  async getFigmaNode(fileKey: string, nodeIds: string[]) {
    const ids = nodeIds.join(',');
    const data = await this.fetchFigmaApi(`/files/${fileKey}/nodes?ids=${ids}`);
    return data;
  }

  async getFigmaDesignSpec(fileKey: string, nodeId: string) {
    const data = await this.getFigmaNode(fileKey, [nodeId]);
    const nodeData = data.nodes[nodeId]?.document;
    if (!nodeData) {
      throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
    }
    return this.normalizeNode(nodeData);
  }

  private normalizeNode(node: any): any {
    if (!node) return null;

    const base: any = {
      id: node.id,
      name: node.name,
      type: node.type,
    };

    if (node.characters) {
      base.text = node.characters;
    }
    
    if (node.absoluteBoundingBox) {
      base.bounds = {
        width: node.absoluteBoundingBox.width,
        height: node.absoluteBoundingBox.height,
      };
    }

    if (node.style) {
      base.typography = {
        fontFamily: node.style.fontFamily,
        fontWeight: node.style.fontWeight,
        fontSize: node.style.fontSize,
        textAlign: node.style.textAlignHorizontal,
        color: this.extractColor(node.fills),
      };
    }

    if (node.fills && !base.typography) {
      base.backgroundColor = this.extractColor(node.fills);
    }

    if (node.strokes && node.strokes.length > 0) {
      base.borderColor = this.extractColor(node.strokes);
      base.borderWeight = node.strokeWeight;
    }

    if (node.cornerRadius) {
      base.cornerRadius = node.cornerRadius;
    }
    
    if (node.layoutMode) {
      base.layout = {
        mode: node.layoutMode,
        padding: [
          node.paddingTop || 0,
          node.paddingRight || 0,
          node.paddingBottom || 0,
          node.paddingLeft || 0,
        ],
        spacing: node.itemSpacing || 0,
      };
    }

    if (node.children && node.children.length > 0) {
      base.children = node.children.map((child: any) => this.normalizeNode(child));
    }

    return base;
  }

  private extractColor(fills: any[]): string | undefined {
    if (!fills || fills.length === 0) return undefined;
    const solidFill = fills.find((f: any) => f.type === 'SOLID' && f.visible !== false);
    if (solidFill && solidFill.color) {
      const { r, g, b, a } = solidFill.color;
      const opacity = solidFill.opacity !== undefined ? solidFill.opacity : (a !== undefined ? a : 1);
      
      const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0');
      
      if (opacity < 1) {
        return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${opacity.toFixed(2)})`;
      } else {
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      }
    }
    return undefined;
  }
}
