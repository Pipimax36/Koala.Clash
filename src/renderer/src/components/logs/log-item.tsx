const LogItem: React.FC<ControllerLog & { index: number }> = ({ type, payload, time }) => (
  <div className="koala-log-row">
    <time title={time}>{time?.match(/\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?/i)?.[0] ?? time}</time>
    <span className="koala-log-level" data-level={type}>
      {type === 'warning' ? 'WARN' : type.toUpperCase()}
    </span>
    <span className="koala-log-message" title={payload}>
      {payload}
    </span>
  </div>
)

export default LogItem
