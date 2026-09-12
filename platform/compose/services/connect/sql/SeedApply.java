import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.Statement;
import java.util.Properties;

public class SeedApply {

    private static final String LOG_PREFIX = "guac-seed: ";

    private static final String USAGE =
        "usage: SeedApply probe <sql> | SeedApply apply <sql-file> [<setting-name>=<ENV_VAR_NAME> ...]";

    private static final String DRIVER = "org.postgresql.Driver";

    public static void main(String[] arguments) {
        int status = 0;
        try {
            run(arguments);
        } catch (Throwable failure) {
            System.err.println(LOG_PREFIX + "FAILED: " + describe(failure));
            status = 1;
        }
        System.exit(status);
    }

    private static void run(String[] arguments) throws Exception {
        if (arguments.length < 2) {
            throw new IllegalArgumentException(USAGE);
        }
        Class.forName(DRIVER);
        if ("probe".equals(arguments[0]) && arguments.length == 2) {
            probe(arguments[1]);
        } else if ("apply".equals(arguments[0])) {
            apply(arguments);
        } else {
            throw new IllegalArgumentException(USAGE);
        }
    }

    private static void probe(String sql) throws SQLException {
        Connection connection = open();
        try {
            Statement statement = connection.createStatement();
            try {
                ResultSet answer = statement.executeQuery(sql);
                try {
                    String value = answer.next() ? answer.getString(1) : null;
                    System.out.println(value == null ? "" : value);
                } finally {
                    answer.close();
                }
            } finally {
                statement.close();
            }
            connection.commit();
        } catch (SQLException failure) {
            connection.rollback();
            throw failure;
        } finally {
            connection.close();
        }
    }

    private static void apply(String[] arguments) throws Exception {
        String path = arguments[1];
        String sql = new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
        Connection connection = open();
        try {
            for (int index = 2; index < arguments.length; index++) {
                bindSettingFromEnvironment(connection, arguments[index]);
            }
            Statement statement = connection.createStatement();
            try {
                boolean holdsRows = statement.execute(sql);
                printWarnings(statement.getWarnings());
                statement.clearWarnings();
                while (true) {
                    if (holdsRows) {
                        printRows(statement.getResultSet());
                    } else if (statement.getUpdateCount() == -1) {
                        break;
                    }
                    holdsRows = statement.getMoreResults();
                    printWarnings(statement.getWarnings());
                    statement.clearWarnings();
                }
            } finally {
                statement.close();
            }
            connection.commit();
        } catch (SQLException failure) {
            connection.rollback();
            throw failure;
        } finally {
            connection.close();
        }
    }

    private static void bindSettingFromEnvironment(Connection connection, String assignment)
            throws SQLException {
        int separator = assignment.indexOf('=');
        if (separator < 1 || separator == assignment.length() - 1) {
            throw new IllegalArgumentException(
                "expected <setting-name>=<ENV_VAR_NAME>, got: " + assignment);
        }
        String settingName = assignment.substring(0, separator);
        String environmentVariableName = assignment.substring(separator + 1);
        PreparedStatement statement = connection.prepareStatement("SELECT set_config(?, ?, false)");
        try {
            statement.setString(1, settingName);
            statement.setString(2, requiredEnvironment(environmentVariableName));
            statement.execute();
        } finally {
            statement.close();
        }
    }

    private static Connection open() throws SQLException {
        Properties settings = new Properties();
        settings.setProperty("user", requiredEnvironment("PGUSER"));
        settings.setProperty("password", requiredEnvironment("PGPASSWORD"));
        settings.setProperty("ApplicationName", "argus-guac-init");
        settings.setProperty("connectTimeout", "10");
        settings.setProperty("socketTimeout", "180");
        String url = "jdbc:postgresql://" + requiredEnvironment("PGHOST") + ":"
            + optionalEnvironment("PGPORT", "5432") + "/" + requiredEnvironment("PGDATABASE");
        Connection connection = DriverManager.getConnection(url, settings);
        connection.setAutoCommit(false);
        return connection;
    }

    private static void printRows(ResultSet rows) throws SQLException {
        if (rows == null) {
            return;
        }
        try {
            ResultSetMetaData columns = rows.getMetaData();
            int columnCount = columns.getColumnCount();
            while (rows.next()) {
                StringBuilder line = new StringBuilder();
                for (int column = 1; column <= columnCount; column++) {
                    if (column > 1) {
                        line.append("  ");
                    }
                    String value = rows.getString(column);
                    line.append(columns.getColumnLabel(column))
                        .append('=')
                        .append(value == null ? "" : value);
                }
                System.out.println(LOG_PREFIX + line);
            }
        } finally {
            rows.close();
        }
    }

    private static void printWarnings(SQLWarning warning) {
        SQLWarning current = warning;
        while (current != null) {
            System.out.println(LOG_PREFIX + current.getMessage());
            current = current.getNextWarning();
        }
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.length() == 0) {
            throw new IllegalStateException(name + " is unset or empty in the guac-init environment");
        }
        return value;
    }

    private static String optionalEnvironment(String name, String fallback) {
        String value = System.getenv(name);
        return (value == null || value.length() == 0) ? fallback : value;
    }

    private static String describe(Throwable failure) {
        StringBuilder text = new StringBuilder();
        Throwable current = failure;
        int depth = 0;
        while (current != null && depth < 16) {
            if (text.length() > 0) {
                text.append(" | ");
            }
            text.append(current.getClass().getSimpleName()).append(": ").append(current.getMessage());
            current = next(current);
            depth++;
        }
        return text.toString();
    }

    private static Throwable next(Throwable current) {
        if (current instanceof SQLException) {
            SQLException chained = ((SQLException) current).getNextException();
            if (chained != null && chained != current) {
                return chained;
            }
        }
        Throwable cause = current.getCause();
        return cause == current ? null : cause;
    }
}
