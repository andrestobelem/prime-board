import { Link } from "../router.tsx";
import { Icon } from "../components/icons.tsx";

interface Project {
  id: string;
  name: string;
  state: string;
}

export function ProjectsView({ projects }: { projects: Project[] }) {
  return (
    <div className="page projects-page">
      <div className="page-header">
        <h1>Projects</h1>
      </div>
      {projects.length === 0 ? (
        <div className="empty">No projects yet.</div>
      ) : (
        <div className="projects-list">
          {projects.map((project) => (
            <Link key={project.id} to={`/project/${project.id}`} className="project-row">
              <Icon name="project" />
              <span>{project.name}</span>
              <span className="muted">{project.state}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
