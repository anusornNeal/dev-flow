export interface DomainProject {
  id: string;
  name: string;
  repoUrl?: string;
  description?: string;
  localPath?: string;
  taskIdPrefix?: string;
  [key: string]: unknown;
}

export function toDomainProject(dto: any): DomainProject {
  return {
    id: dto?.id,
    name: dto?.name,
    repoUrl: dto?.repoUrl,
    description: dto?.description,
    localPath: dto?.localPath,
    taskIdPrefix: dto?.taskIdPrefix,
  };
}

export function toDtoProject(domain: DomainProject): any {
  return { ...domain };
}
